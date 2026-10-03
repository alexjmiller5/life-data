// Capabilities describe the protocol a credential may use; they never expand grants.
export const scopedReplicaUnsupported = Object.freeze({
  error: 'scoped_replica_unsupported',
  message: 'This credential supports direct API access only; replica synchronization requires broader table access.',
});

export function hasSchemaAccess(scopes) {
  return scopes.some(scope => ['admin', 'full', 'tables:read'].includes(scope));
}

export function sessionCapabilities(scopes) {
  return {
    row_api: 'v1',
    schema: hasSchemaAccess(scopes) ? 'full-ddl-v1' : 'none',
    replica_sync: scopes.some(scope => ['admin', 'full'].includes(scope)),
    subscriptions: 'durable-pull-v1',
    files: 'opaque-key-v1',
  };
}

import { qident } from './validate.js';
import { trustedSubscriptionTrigger } from './subscription-triggers.js';
import { checkedReads, readGuards } from './write.js';

export class ScopeDenied extends Error {}
const deny = () => { throw new ScopeDenied('insufficient scope'); };
const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const ordinaryName = name => identifier(name) && !/^(?:_|sqlite_|catalog_)/i.test(name)
  && !/^(?:history|provenance|purges)$/i.test(name);
export const broadTableAccess = (scopes, operation) => scopes.some(s => ['admin','full',`tables:${operation}`].includes(s));
export function authorizeTable(scopes, operation, table) {
  return ordinaryName(table) && scopes.includes(`tables:${operation}:${table}`);
}

// Exact server-owned DDL only. A familiar trigger name does not establish trust.
export function timestampTrigger(trigger) {
  const table=trigger.tbl_name;
  if (!identifier(table)) return false;
  const canonical=`CREATE TRIGGER ${qident(`${table}_updated_at`)} AFTER UPDATE ON ${qident(table)} FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE ${qident(table)} SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid; END`;
  return String(trigger.sql).replace(/\s+/g,' ').trim() === canonical;
}
function safeDefault(value) {
  if (value == null) return true;
  let text=String(value).trim();
  while (text.startsWith('(') && text.endsWith(')')) text=text.slice(1,-1).trim();
  return /^(?:NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|'(?:[^']|'')*'|x'(?:[0-9a-f]{2})*')$/i.test(text)
    || text === "strftime('%Y-%m-%dT%H:%M:%fZ','now')" || text === 'lower(hex(randomblob(16)))';
}

export async function scopedTable(view, table, write=false) {
  if (!ordinaryName(table)) deny();
  const schema=await view.prepare("SELECT name,type,sql FROM sqlite_master WHERE name=?").bind(table).first();
  if (!schema || schema.type !== 'table' || !/^CREATE\s+TABLE\b/i.test(schema.sql)) deny();
  if (!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_tables'").first()) deny();
  const catalog=await view.prepare('SELECT * FROM catalog_tables WHERE id=? AND deleted_at IS NULL').bind(table).first();
  if (!catalog || ![null,undefined,'','table'].includes(catalog.kind)) deny();
  const {results:columns}=await view.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').bind(table).all();
  if (columns.some(c=>c.hidden || !identifier(c.name)) || !columns.some(c=>c.name==='id' && c.pk===1)
    || columns.filter(c=>c.pk).length!==1 || !columns.some(c=>c.name==='updated_at')) deny();
  if (!write) return columns;
  // Existing broad push recovery applies purges after its checked transaction.
  // Narrow writes cannot run that unguarded side-effect path. Capture its absence
  // in the write read-set so a concurrent marker also prevents the mutation.
  if (await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purges'").first()) {
    const {results:purges}=await view.prepare('SELECT * FROM purges WHERE tbl=? AND deleted_at IS NULL ORDER BY id').bind(table).all();
    if (purges.length) deny();
  }
  if (columns.some(c=>!safeDefault(c.dflt_value))) deny();
  const {results:triggers}=await view.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name COLLATE NOCASE IN (?, 'history', 'provenance', '_change_events', '_change_subscriptions') ORDER BY name").bind(table).all();
  for (const trigger of triggers) {
    if (['_change_events','_change_subscriptions'].includes(trigger.tbl_name.toLowerCase())) deny();
    if (!timestampTrigger(trigger) && !await trustedSubscriptionTrigger(view,trigger)) deny();
  }
  const {results:foreignKeys}=await view.prepare("SELECT m.name,f.id,f.seq FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND m.name NOT LIKE '_cf_%' ORDER BY m.name,f.id,f.seq").all();
  if (foreignKeys.length) deny();
  if (!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'").first()) deny();
  const {results:props}=await view.prepare('SELECT * FROM catalog_properties WHERE tbl=? AND deleted_at IS NULL ORDER BY id').bind(table).all();
  if (!props.length || props.some(p=>p.options_sql || p.derived_by || String(p.default_value ?? '').startsWith('sql:'))) deny();
  for (const prop of props) if (prop.ref_table) await scopedTable(view,prop.ref_table);
  if (await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_rules'").first()) {
    const {results:rules}=await view.prepare("SELECT * FROM catalog_rules WHERE deleted_at IS NULL AND kind='invariant' AND enforce != 0 AND (tbl=? OR scope='estate') ORDER BY id").bind(table).all();
    if (rules.length) deny();
  }
  return columns;
}

export async function scopedRows(body,db) {
  const view=checkedReads(db),schema=await scopedTable(view,body.table);
  const names=new Set(schema.map(c=>c.name)),limit=body.limit ?? 100;
  const columns=body.columns ?? [...names],where=body.where ?? {},since=body.since ?? '';
  const bad=()=>new Response(JSON.stringify({error:'invalid row request'}),{status:400,headers:{'Content-Type':'application/json'}});
  if (!Number.isInteger(limit) || limit<1 || limit>200 || !Array.isArray(columns) || !columns.length
    || columns.some(c=>!names.has(c)) || typeof since!=='string' || (body.after!==undefined && typeof body.after!=='string')
    || !where || typeof where!=='object' || Array.isArray(where)
    || Object.entries(where).some(([c,v])=>!names.has(c) || !['string','number'].includes(typeof v))) return bad();
  const selected=[...new Set([...columns,'id'])],args=[],conditions=[];
  if(since) {conditions.push(`${names.has('hub_at')?'hub_at':'updated_at'} >= ?`);args.push(since);}
  for(const [c,v] of Object.entries(where)){conditions.push(`${qident(c)} = ?`);args.push(v);}
  const id=since && names.has('hub_at')?'+id':'id';
  if(body.after!==undefined){conditions.push(`${id} > ?`);args.push(body.after);}
  const sql=`SELECT ${selected.map(qident).join(',')} FROM ${qident(body.table)} ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY ${id} LIMIT ?`;
  const result=await db.batch([...readGuards(db,view.reads),db.prepare(sql).bind(...args,limit)]);
  const rows=result.at(-1).results ?? [],next_cursor=rows.length===limit?rows.at(-1).id:null;
  if(!columns.includes('id')) for(const row of rows) delete row.id;
  return {rows,next_cursor};
}

export function scopedResult(result) {
  if (!result || !Array.isArray(result.rejected)) return result;
  return {...result,rejected:result.rejected.map(r=>({id:r.id,col:null,rule:'validation',message:'Row rejected.',...(r.retryable?{retryable:true}:{})}))};
}
