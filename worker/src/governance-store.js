// Private data-writer state. Receipt insertion belongs in the SAME D1 batch
// as its mutation; the primary key excludes every late execution of that key.
import { sha256hex } from './validate.js';

export const RECEIPTS_DDL = `CREATE TABLE IF NOT EXISTS _governance_receipts (
  receipt_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  columns_json TEXT NOT NULL CHECK(json_valid(columns_json)),
  status INTEGER NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result))
)`;

export async function ensureReceiptStorage(db) {
  await db.prepare(RECEIPTS_DDL).run();
}

// Request identity is semantic JSON object identity; array order is significant.
// Callers validate their canonical arguments before computing this identity.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  throw new TypeError('Expected JSON request');
}

export async function receiptIdentity({deploymentId,principalId,operation,idempotencyKey}, request) {
  const scope=[deploymentId,principalId,operation,idempotencyKey];
  if (scope.some(v=>typeof v!=='string' || !v.length)) throw new TypeError('Missing receipt identity');
  return {
    key: await sha256hex(JSON.stringify(['governance-receipt-v1',...scope])),
    requestHash: await sha256hex(canonical(request)),
  };
}

// Disclosure authorization is the caller's responsibility, both before this
// lookup and against its returned target. A mismatch never returns stored data.
export async function readReceipt(db, identity) {
  const row=await db.prepare('SELECT * FROM _governance_receipts WHERE receipt_key=?').bind(identity.key).first();
  if (!row) return null;
  if (row.request_hash!==identity.requestHash) return {mismatch:true};
  return {target:{table:row.tbl,rowId:row.row_id},columns:JSON.parse(row.columns_json),status:row.status,result:JSON.parse(row.result)};
}

// resultSql is trusted service SQL producing one JSON `result`. In approval it
// reads the committed row revision/history inside the enclosing writer batch.
// A missing result fails NOT NULL instead of acknowledging without a receipt.
export function receiptStatement(db, identity, target, columns, status, resultSql, resultArgs=[]) {
  return db.prepare(`INSERT INTO _governance_receipts
    (receipt_key,request_hash,tbl,row_id,columns_json,status,result)
    VALUES (?,?,?,?,?,?,(SELECT result FROM (${resultSql})))`)
    .bind(identity.key,identity.requestHash,target.table,target.rowId,JSON.stringify(columns),status,...resultArgs);
}

// Keep the exclusion key and request fingerprint after purge; erase every
// payload (including negative conflict details). Retry can return only purged.
export function redactReceipts(db, target, column=null) {
  return [db.prepare(`UPDATE _governance_receipts SET result='{"kind":"purged"}',status=200,columns_json='[]'
    WHERE tbl=? AND row_id=? AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(columns_json) WHERE value=?))`)
    .bind(target.table,target.rowId,column,column)];
}
