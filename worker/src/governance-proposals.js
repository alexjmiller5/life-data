import {ensureReceiptStorage} from './governance-store.js';
import {permits} from './governance-preview.js';
import {ScopeDenied} from './scopes.js';
export const PROPOSAL_DDL=[
  `CREATE TABLE IF NOT EXISTS _governance_proposals (
      id TEXT PRIMARY KEY,tbl TEXT NOT NULL,row_id TEXT NOT NULL,version TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','purged')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _governance_versions (
      proposal_id TEXT NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),
      columns_json TEXT NOT NULL CHECK(json_valid(columns_json)),PRIMARY KEY(proposal_id,version))`,
];
export async function ensureProposalStorage(db){
  await ensureReceiptStorage(db);
  await db.batch(PROPOSAL_DDL.map(sql=>db.prepare(sql)));
}
export async function loadProposal(view,tenant,id,version){
  const header=await view.prepare('SELECT * FROM _governance_proposals WHERE id=?').bind(id).first();
  if(!header)return null;
  const target={table:header.tbl,rowId:header.row_id};
  if(!permits(tenant,target))throw new ScopeDenied();
  if(header.state==='purged')return {header,target,proposal:null};
  const row=await view.prepare('SELECT payload FROM _governance_versions WHERE proposal_id=? AND version=?').bind(id,version ?? header.version).first();
  if(!row)return {header,target,proposal:null};
  const proposal=JSON.parse(row.payload);
  if(proposal.version===header.version){proposal.state=header.state;proposal.updatedAt=header.updated_at;}
  return {header,target,proposal};
}
export function storeProposal(db,proposal,create=false){
  return [
    ...(create?[db.prepare('INSERT INTO _governance_proposals(id,tbl,row_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(proposal.id,proposal.target.table,proposal.target.rowId,proposal.version,proposal.state,proposal.createdAt,proposal.updatedAt)]
      :[db.prepare('UPDATE _governance_proposals SET version=?,updated_at=? WHERE id=?').bind(proposal.version,proposal.updatedAt,proposal.id)]),
    db.prepare('INSERT INTO _governance_versions(proposal_id,version,payload,columns_json) VALUES (?,?,?,?)').bind(proposal.id,proposal.version,JSON.stringify(proposal),JSON.stringify(proposal.changes.map(c=>c.column))),
  ];
}
