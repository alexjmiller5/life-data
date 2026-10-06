import { expect,test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { scopedOrigin } from '../src/scopes.js';

const options={
  from:"SELECT DISTINCT derived_by FROM catalog_properties WHERE derived_by IS NOT NULL AND deleted_at IS NULL",
  to:"SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'catalog!_%' ESCAPE '!' AND name NOT LIKE 'sqlite%' AND name != 'provenance'",
};
function db() {
  const db=new D1Shim();db.db.exec(`
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
    CREATE TABLE provenance(id TEXT PRIMARY KEY,from_kind TEXT,to_kind TEXT,to_ref TEXT,rel TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE records(id TEXT PRIMARY KEY,state TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE secret(id TEXT PRIMARY KEY,value TEXT);
    INSERT INTO catalog_tables VALUES('provenance','table',NULL),('records','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES('from','provenance','from_kind','select'),('to','provenance','to_kind','select');
  `);
  db.db.query('UPDATE catalog_properties SET options_sql=? WHERE id=?').run(options.from,'from');
  db.db.query('UPDATE catalog_properties SET options_sql=? WHERE id=?').run(options.to,'to');
  db.db.query('INSERT INTO catalog_rules VALUES(?,?,?,?,?,?,NULL)').run('guard','provenance','invariant',1,'table',"SELECT p.id FROM records p WHERE p.deleted_at IS NULL AND p.state='kept' AND NOT EXISTS (SELECT 1 FROM provenance v WHERE v.deleted_at IS NULL AND v.to_kind='records' AND v.to_ref=p.id AND v.rel='evidence_of')");
  return db;
}
test('internal origin eligibility accepts only bounded catalog option and evidence dependency shapes',async()=>{
  expect((await scopedOrigin(db(),['new'])).map(c=>c.name)).toContain('from_kind');
});
for(const sql of [
 'SELECT value FROM secret',
 "SELECT DISTINCT derived_by FROM catalog_properties WHERE derived_by IS NOT NULL AND deleted_at IS NULL UNION SELECT value FROM secret",
 "SELECT name FROM sqlite_master",
 "DELETE FROM secret RETURNING value",
])test('arbitrary origin option SQL stays denied: '+sql,async()=>{
 const d=db();d.db.query("UPDATE catalog_properties SET options_sql=? WHERE id='from'").run(sql);
 await expect(scopedOrigin(d,['new'])).rejects.toThrow('insufficient scope');
});
for(const update of [
 "UPDATE catalog_rules SET sql='SELECT id FROM secret'",
 "UPDATE catalog_rules SET scope='estate'",
 "DROP TABLE records; CREATE VIEW records AS SELECT id,value AS state,NULL AS updated_at,NULL AS deleted_at FROM secret",
 "UPDATE catalog_rules SET sql=replace(sql,'p.state','p.missing')",
 "CREATE TRIGGER leaked AFTER INSERT ON provenance BEGIN INSERT INTO secret VALUES(NEW.id,NEW.from_kind); END",
])test('unknown rules, missing dependencies and side effects stay denied: '+update,async()=>{
 const d=db();d.db.exec(update);await expect(scopedOrigin(d,['new'])).rejects.toThrow('insufficient scope');
});
