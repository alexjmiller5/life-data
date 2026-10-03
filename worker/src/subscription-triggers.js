import { literal, qident } from './validate.js';

export const MAX_DELIVERY_BYTES = 1_048_576;
export const MAX_EVENT_BYTES = MAX_DELIVERY_BYTES - 4096;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const revision = (alias, hasHubAt) => `json_object('updated_at',${alias}.updated_at,'hub_at',${hasHubAt ? `${alias}.hub_at` : 'NULL'})`;

// Persisted triggers use only literal selectors and OLD/NEW. They run in every
// writing transaction, including derives, direct SQL and physical deletions.
export function subscriptionTriggers(id, sources) {
  return sources.flatMap((source, index) => ['INSERT','UPDATE','DELETE'].map(operation => {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    const oldValue = column => operation === 'INSERT' ? 'NULL'
      : operation === 'UPDATE' ? `CASE WHEN OLD.deleted_at IS NULL THEN OLD.${qident(column)} END` : `OLD.${qident(column)}`;
    const newValue = column => operation === 'DELETE' ? 'NULL' : `CASE WHEN NEW.deleted_at IS NULL THEN NEW.${qident(column)} END`;
    const changed = source.columns.map(column => `${oldValue(column)} IS NOT ${newValue(column)}`).join(' OR ');
    const changes = `(SELECT json_group_array(json(item)) FROM (${source.columns.map(column =>
      `SELECT json_object('column',${literal(column)},'old_value',${oldValue(column)},'new_value',${newValue(column)}) AS item WHERE ${oldValue(column)} IS NOT ${newValue(column)}`
    ).join(' UNION ALL ')}))`;
    const kind = operation === 'UPDATE' ? "CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'update' END" : literal(operation.toLowerCase());
    const before = operation === 'INSERT' ? 'NULL' : revision('OLD', source.hasHubAt);
    const after = operation === 'DELETE' ? 'NULL' : `CASE WHEN NEW.deleted_at IS NULL THEN ${revision('NEW', source.hasHubAt)} END`;
    const payload = `json_object('operation',${kind},'source',json_object('table',${literal(source.table)},'row_id',CAST(${row}.id AS TEXT),'before_revision',${before},'after_revision',${after}),'changes',json(${changes}))`;
    // Conservatively account for ID/sequence/time fields and delivery punctuation.
    const bytes = `(length(CAST(${payload} AS BLOB)) + 256)`;
    const active = `id=${literal(id)} AND state IN ('active','paused')`;
    const name = `_change_${id.replaceAll('-','')}_${index}_${operation.toLowerCase()}`;
    const sql = `CREATE TRIGGER ${qident(name)} AFTER ${operation} ON ${qident(source.table)}
      WHEN (${changed}) AND EXISTS (SELECT 1 FROM _change_subscriptions WHERE ${active})
      BEGIN
        SELECT RAISE(ABORT,'life_outbox_event_size') WHERE ${bytes} > ${MAX_EVENT_BYTES};
        SELECT RAISE(ABORT,'life_outbox_capacity') WHERE EXISTS (
          SELECT 1 FROM _change_subscriptions WHERE ${active} AND
          (pending_event_count >= max_pending_events OR pending_byte_count + ${bytes} > max_pending_bytes OR last_seq >= 9223372036854775807));
        UPDATE _change_subscriptions SET last_seq=last_seq+1,
          pending_event_count=pending_event_count+1,pending_byte_count=pending_byte_count+${bytes}
          WHERE ${active};
        INSERT INTO _change_events(subscription_id,seq,event_id,recorded_at,payload_json,accounted_bytes)
          SELECT id,last_seq,lower(hex(randomblob(16))),${now},${payload},${bytes}
          FROM _change_subscriptions WHERE ${active};
      END`;
    return {name,table:source.table,sql};
  }));
}

export async function trustedSubscriptionTrigger(db, trigger) {
  const match = /^_change_([0-9a-f]{32})_\d+_(insert|update|delete)$/.exec(trigger.name);
  if (!match) return false;
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_change_subscriptions'").first()) return false;
  const row = await db.prepare("SELECT id,trigger_sources_json FROM _change_subscriptions WHERE replace(id,'-','')=?").bind(match[1]).first();
  if (!row) return false;
  const expected=subscriptionTriggers(row.id,JSON.parse(row.trigger_sources_json)).find(t=>t.name===trigger.name);
  return expected?.table===trigger.tbl_name && expected.sql===trigger.sql;
}
