import { checkedReads, commitChecked, enforcedRules, queryBudget } from './write.js';
import { historyPlan } from './history.js';
import { ident, qident, validEditTimestamp, validatePush } from './validate.js';

const reply = (error, status) => Response.json({error}, {status});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['id','created_at','updated_at','hub_at','deleted_at']);
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** One existing-row mutation with a client revision and transactional read guards.
 * Receipts come from the committing batch, never a later unguarded row read. */
export async function patchChecked(db, body, policy = null) {
  const plan=await preparePatch(db,body,policy);
  return plan instanceof Response ? plan : commitPreparedPatch(plan);
}

// Planning captures the same read guards for both preview and commit. The
// optional view lets a governance operation bind its evidence/proposal reads
// into this writer transaction instead of doing an unguarded client pre-read.
export async function preparePatch(db, body, policy = null, options = {}) {
  if (!object(body) || Object.keys(body).some(k=>!['table','id','values','expected_revision'].includes(k))
    || typeof body.id !== 'string' || !body.id.trim() || !object(body.values)
    || !Object.keys(body.values).length || !object(body.expected_revision)) return reply('invalid_patch',400);
  const revision=body.expected_revision;
  if (Object.keys(revision).sort().join(',') !== 'hub_at,updated_at' || !validEditTimestamp(revision.updated_at)
    || (revision.hub_at !== null && !validEditTimestamp(revision.hub_at))) return reply('invalid_patch',400);
  let table,columns;
  try {
    table=ident(body.table);
    columns=Object.keys(body.values).map(ident);
    if (columns.some(c=>forbidden.has(c))) return reply('invalid_patch',400);
  } catch { return reply('invalid_patch',400); }

  db=queryBudget(db,750);
  const view=options.view ?? checkedReads(db);
  if (policy) await policy(view,table,true,[body.id]);
  const {results:schema}=await view.prepare('SELECT * FROM pragma_table_info(?) ORDER BY cid').bind(table).all();
  const names=new Set(schema.map(c=>c.name));
  if (!['id','updated_at','deleted_at'].every(c=>names.has(c)) || columns.some(c=>!names.has(c))) return reply('invalid_patch',400);
  await view.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name").all();
  const before=await view.prepare(`SELECT * FROM ${qident(table)} WHERE id=?`).bind(body.id).first();
  if (!before || before.deleted_at !== null || before.updated_at !== revision.updated_at
    || (before.hub_at ?? null) !== revision.hub_at) return reply('revision_conflict',409);
  const millis=Math.max(Date.now(),Date.parse(revision.updated_at)+1);
  const updatedAt=new Date(millis).toISOString();
  if (!validEditTimestamp(updatedAt)) return reply('invalid_patch',400);
  const proposal={id:body.id,...body.values,updated_at:updatedAt};
  const {accepted,rejected,expected,props,transitions}=await validatePush(view,table,[proposal],db);
  if (rejected.length || accepted.length!==1 || expected.length!==1) return reply('validation_failed',422);
  const rules=await enforcedRules(view,table);
  const log=await historyPlan(view,db,table,accepted,[],transitions);
  if(log){log.actor=options.actor ?? null;log.operationId=options.operationId ?? null;}
  const changed=[...columns,'updated_at'];
  const stamping=names.has('hub_at');
  // Bind one JSON document regardless of the number of changed columns.
  const assignments=changed.map(c=>`${qident(c)}=json_extract(?1,'$."${c}"')`);
  if (stamping) assignments.push(`"hub_at"=(${now})`);
  const mutation=db.prepare(`UPDATE ${qident(table)} SET ${assignments.join(',')} WHERE id=?2
    RETURNING id,updated_at${stamping?',hub_at':''}`).bind(JSON.stringify(accepted[0]),body.id);
  // RAISE(IGNORE) or an AFTER trigger must not turn a missing/suppressed write
  // into a success receipt. This assertion also rolls back its history/outbox.
  const committed=db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ${qident(table)} WHERE id=? AND updated_at=?)
    THEN 1 ELSE abs(-9223372036854775808) END AS life_write_conflict`).bind(body.id,updatedAt);
  return {db,view,table,rules,stamping,statements:[mutation,committed],updatedAt,log,expected,props,transitions};
}

// Trusted service statements may join the existing transaction. In particular,
// proposal state and terminal receipts must never commit in a separate batch.
export async function commitPreparedPatch(plan,{before=[],after=[],probe=false}={}) {
  const {db,view,table,rules,statements,updatedAt,log,expected,props,transitions}=plan;
  try {
    const receipts=await commitChecked(db,view.reads,table,rules,[...before,...statements,...after],updatedAt,log,expected,props,transitions,probe);
    if(probe)return null;
    const row=receipts[before.length].results[0];
    return {id:row.id,revision:{updated_at:row.updated_at,hub_at:row.hub_at ?? null}};
  } catch (error) {
    const message=String(error);
    if (/life_write_conflict|integer overflow/.test(message)) return reply('revision_conflict',409);
    if (/life_invariant_|life_property_/.test(message)) return reply('validation_failed',422);
    if (/life_outbox_capacity|life_write_budget/.test(message)) return reply('write_capacity',503);
    if (/life_outbox_event_size/.test(message)) return reply('event_too_large',422);
    throw error;
  }
}
