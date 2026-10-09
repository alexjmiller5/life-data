import {expect,test} from 'bun:test';
import hub from '../src/index.js';
import {D1Shim} from './d1shim.js';
import {ensureReceiptStorage} from '../src/governance-store.js';
const request=(path,body)=>new Request('https://hub.test'+path,{method:'POST',headers:{Authorization:'Bearer operator','Content-Type':'application/json'},body:JSON.stringify(body)});
async function fixture(){
  const env={DB:new D1Shim(),AUTH_DB:new D1Shim(),HUB_TOKEN:'operator'};
  await ensureReceiptStorage(env.DB);
  env.DB.db.exec(`INSERT INTO _governance_receipts VALUES ('key','hash','items','r','[]',200,'{"kind":"purged"}')`);
  return {env,call:(path,body)=>hub.fetch(request(path,body),env,{waitUntil(){}})};
}
for(const ddl of [
  'DELETE FROM _governance_receipts',
  'DROP TABLE "_GoVeRnAnCe_receipts"',
  'CREATE VIEW exposed AS SELECT result FROM [_governance_receipts]',
  "CREATE TABLE exposed AS SELECT * FROM '_governance_receipts'",
  "CREATE TRIGGER forged AFTER INSERT ON items BEGIN DELETE FROM `_governance_receipts`; END",
  'PRAGMA writable_schema=ON',
  "UPDATE sqlite_master SET sql='CREATE TABLE forged(x)' WHERE name='items'",
])test('schema replay cannot address private approval state: '+ddl,async()=>{
  const {env,call}=await fixture();
  env.DB.db.exec('CREATE TABLE items(id TEXT)');
  const r=await call('/v1/schema/push',{entries:[{ddl,applied_at:'2025-01-01'}]});
  expect(r.status).toBe(403);
  expect(env.DB.db.query('SELECT receipt_key FROM _governance_receipts').all()).toEqual([{receipt_key:'key'}]);
  expect(env.DB.db.query('SELECT * FROM _schema_log').all()).toEqual([]);
});
for(const path of ['/v1/rows/pull','/v1/rows/push','/v1/rows/insert','/v1/rows/patch'])
test('even admin cannot address private state through '+path,async()=>{
  const {env,call}=await fixture();
  const r=await call(path,{table:'_GoVeRnAnCe_receipts',rows:[],columns:['id'],values:{result:'forged'},id:'key',expected_revision:{updated_at:'2025-01-01T00:00:00.000Z',hub_at:null}});
  expect(r.status).toBe(403);
  expect(env.DB.db.query('SELECT result FROM _governance_receipts').get().result).toBe('{"kind":"purged"}');
});
test('pre-existing view or trigger aliases to private state deny generic row access',async()=>{
  const {env,call}=await fixture();
  env.DB.db.exec('CREATE VIEW exposed AS SELECT result FROM _governance_receipts');
  const r=await call('/v1/rows/pull',{table:'exposed'});
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({error:'insufficient scope'});
});
test('ordinary schema replay remains available, but data writes disguised as DDL do not',async()=>{
  const {env,call}=await fixture();
  const r=await call('/v1/schema/push',{entries:[{ddl:'CREATE TABLE ordinary(id TEXT PRIMARY KEY,updated_at TEXT,deleted_at TEXT)',applied_at:'2025'}]});
  expect(r.status).toBe(200);
  expect((await call('/v1/schema/push',{entries:[{ddl:"INSERT INTO ordinary VALUES ('r','now',NULL)",applied_at:'2026'}]})).status).toBe(403);
  expect(env.DB.db.query('SELECT * FROM ordinary').all()).toEqual([]);
});
test('catalog SQL cannot be used as an indirect private-state reader',async()=>{
  const {call}=await fixture();
  const r=await call('/v1/rows/push',{table:'catalog_properties',columns:['id','options_sql','updated_at'],rows:[{id:'x',options_sql:'SELECT result FROM _governance_receipts',updated_at:'2025-01-01T00:00:00.000Z'}]});
  expect(r.status).toBe(403);
});
test('a purge marker cannot target private proposal or receipt state',async()=>{
  const {call}=await fixture();
  const r=await call('/v1/rows/push',{table:'purges',columns:['id','tbl','row_id','updated_at'],rows:[{id:'purge','tbl':'_governance_proposals',row_id:'p',updated_at:'2025-01-01T00:00:00.000Z'}]});
  expect(r.status).toBe(403);
});
test('catalog SQL assembled by an ordinary trigger is rejected at its eventual execution boundary',async()=>{
  const {env}=await fixture();
  env.DB.db.exec(`CREATE TABLE catalog_properties(id TEXT,tbl TEXT,col TEXT,type TEXT,sort INTEGER,deleted_at TEXT,options_sql TEXT);
    INSERT INTO catalog_properties VALUES ('p','items','label','select',0,NULL,'SELECT result FROM '||char(95)||'governance_receipts');`);
  const {validatePush}=await import('../src/validate.js');
  await expect(validatePush(env.DB,'items',[{id:'r',label:'anything'}])).rejects.toThrow('insufficient scope');
});
test('a familiar private table name is not proof of the service-owned schema',async()=>{
  const {env,call}=await fixture();
  env.DB.db.exec('ALTER TABLE _governance_receipts ADD COLUMN unexpected TEXT');
  const r=await call('/v1/schema/pull',{});
  expect(r.status).toBe(403);
});
test('reserved names stored in catalog SQL deny generic row access',async()=>{
  for(const [ddl,row] of [
    ['CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,options_sql TEXT,updated_at TEXT)',"INSERT INTO catalog_properties VALUES ('p','SELECT result FROM _governance_receipts','2025')"],
    ['CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,sql TEXT,updated_at TEXT)',"INSERT INTO catalog_rules VALUES ('r','SELECT 1 FROM _governance_receipts','2025')"],
  ]){
    const {env,call}=await fixture();
    env.DB.db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,updated_at TEXT,hub_at TEXT)');
    env.DB.db.exec(ddl);
    expect((await call('/v1/rows/pull',{table:'items',columns:['id'],since:'',limit:1})).status).toBe(200);
    env.DB.db.exec(row);
    expect((await call('/v1/rows/pull',{table:'items',columns:['id'],since:'',limit:1})).status).toBe(403);
  }
});
