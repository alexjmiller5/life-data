// Private proposal and original-key receipt state, never replica content.
export const CHANGESET_DDL=[
  `CREATE TABLE IF NOT EXISTS _governance_changesets (
    id TEXT PRIMARY KEY,version TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','purged')),
    payload TEXT CHECK(payload IS NULL OR json_valid(payload)),targets_json TEXT NOT NULL CHECK(json_valid(targets_json)),
    updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _governance_changeset_receipts (
    receipt_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status INTEGER NOT NULL,
    result TEXT NOT NULL CHECK(json_valid(result)),targets_json TEXT NOT NULL CHECK(json_valid(targets_json)))`,
];
export async function ensureChangesetStorage(db){await db.batch(CHANGESET_DDL.map(sql=>db.prepare(sql)));}
export function changesetReceipt(db,identity,status,targets,sql,args=[]){
  return db.prepare(`INSERT INTO _governance_changeset_receipts VALUES(?,?,?,(SELECT result FROM (${sql})),?)`)
    .bind(identity.key,identity.requestHash,status,...args,JSON.stringify(targets));
}
export async function readChangesetReceipt(db,identity){
  const row=await db.prepare('SELECT request_hash,status,result FROM _governance_changeset_receipts WHERE receipt_key=?').bind(identity.key).first();
  if(!row)return null;
  return row.request_hash===identity.requestHash?{status:row.status,body:JSON.parse(row.result)}:{status:409,body:{kind:'error',code:'idempotency_conflict',resolution:'unresolved',conflicts:[]}};
}
export function purgeChangesets(db,table,id){
  // Table-wide dependencies deliberately over-redact rather than retain a
  // proposal that may refer to a purged sibling or dynamically selected option.
  const affected=`EXISTS(SELECT 1 FROM json_each(targets_json) WHERE json_extract(value,'$.table')=?
    AND (json_extract(value,'$.id') IS NULL OR json_extract(value,'$.id')=?))`;
  return [db.prepare(`UPDATE _governance_changesets SET state='purged',payload=NULL WHERE ${affected}`).bind(table,id),
    db.prepare(`UPDATE _governance_changeset_receipts SET status=200,result='{"kind":"purged"}' WHERE ${affected}`).bind(table,id)];
}
