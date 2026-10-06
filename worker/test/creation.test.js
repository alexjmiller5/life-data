import { expect, test } from 'bun:test';
import worker from '../src/index.js';
import meteredWorker from '../src/main.js';
import {ensureUsage,period} from '../src/usage.js';
import { D1Shim } from './d1shim.js';
import { creationPolicies, creationId } from '../src/creation.js';

const T='2026-01-01T00:00:00.000Z';
const config={
  namespace:'11111111-2222-4333-8444-555555555555',sourceKind:'fixture-event',
  occurrenceType:'integer',table:'items',columns:['title'],
  origin:{kind:'fixture-source',table:'sources',relation:'imported_from'},
};
function database() {
  const db=new D1Shim();
  db.db.exec(`
    CREATE TABLE items(id TEXT PRIMARY KEY,title TEXT,created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE sources(id TEXT PRIMARY KEY,title TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE provenance(id TEXT PRIMARY KEY,from_kind TEXT,from_ref TEXT,to_kind TEXT,to_ref TEXT,field TEXT,rel TEXT,asserted_by TEXT,produced_at TEXT,created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE purges(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,deleted_at TEXT);
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,text TEXT,deleted_at TEXT);
    INSERT INTO catalog_tables VALUES ('items','table',NULL),('sources','table',NULL),('provenance','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type,required) VALUES
      ('title','items','title','text',1),('source-title','sources','title','text',0),
      ('from-kind','provenance','from_kind','text',1),('from-ref','provenance','from_ref','text',1),
      ('to-kind','provenance','to_kind','text',1),('to-ref','provenance','to_ref','text',1),
      ('rel','provenance','rel','text',1),('actor','provenance','asserted_by','text',1);
    INSERT INTO sources VALUES ('source-1','private source title','${T}',NULL);
  `);
  return db;
}
async function setup(extraScopes=[]) {
  const env={HUB_TOKEN:'fixture-operator',AUTH_DB:new D1Shim(),DB:database(),ROW_CREATION_POLICIES:JSON.stringify({fixture:config})};
  const [policy]=await creationPolicies(env);
  const scope=`rows:create:fixture:${policy.revision}`;
  const ctx={waitUntil(){}}; // ordinary authentication may update last_used_at
  const request=(token,path,body,method='POST')=>worker.fetch(new Request('https://hub.test'+path,{
    method,headers:{Authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),env,ctx);
  const mint=await request('fixture-operator','/v1/tokens/create',{name:'fixture-caller',scopes:[scope,...extraScopes].join(',')});
  const {token}=await mint.json();
  const id=await creationId(config,'source-1',2030);
  const input={policy:{id:'fixture',revision:policy.revision},sourceId:'source-1',occurrenceKey:2030,target:{kind:'generated',id},updatedAt:T,values:{title:'initializer'}};
  return {env,policy,input,token,request,call:(body=input)=>request(token,'/v1/rows/create',body)};
}
const snapshot=db=>Object.fromEntries(['items','provenance','history'].map(t=>[t,db.db.query(`SELECT * FROM ${t} ORDER BY id`).all()]));

test('portable UUIDv5 vectors preserve integer type and exact Unicode bytes',async()=>{
  expect(await creationId(config,'source-1',2030)).toBe('03e4ced10ff85f249d6b14c96dd6d0b3');
  expect(await creationId(config,'source-1','2030')).toBe('3f0980b266f75ed49383fe481b22da3c');
  expect(await creationId(config,' ź/😀\\" ',2030)).toBe('c26d8fe2536a553e93513228ae432e45');
  expect(await creationId(config,'é',2030)).not.toBe(await creationId(config,'e\u0301',2030));
});

for(const state of ['valid','invalid','concurrent'])test('HTTP atomic origin honors dynamic options and whole-table evidence rule: '+state,async()=>{
  const {env,call}=await setup();
  env.DB.db.exec(`
    CREATE TABLE records(id TEXT PRIMARY KEY,state TEXT,updated_at TEXT,deleted_at TEXT);
    INSERT INTO catalog_tables VALUES('records','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES('record-state','records','state','text');
  `);
  env.DB.db.query("UPDATE catalog_properties SET type='select',options=?,options_sql=? WHERE id='from-kind'").run(
    JSON.stringify([{v:'fixture-source',d:'Fixture'}]),
    'SELECT DISTINCT derived_by FROM catalog_properties WHERE derived_by IS NOT NULL AND deleted_at IS NULL');
  env.DB.db.query("UPDATE catalog_properties SET type='select',options_sql=? WHERE id='to-kind'").run(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'catalog!_%' ESCAPE '!' AND name NOT LIKE 'sqlite%' AND name != 'provenance'");
  env.DB.db.query('INSERT INTO catalog_rules(id,tbl,kind,enforce,scope,sql) VALUES(?,?,?,?,?,?)').run('proof','provenance','invariant',1,'table',
    "SELECT p.id FROM records p WHERE p.deleted_at IS NULL AND p.state='kept' AND NOT EXISTS (SELECT 1 FROM provenance v WHERE v.deleted_at IS NULL AND v.to_kind='records' AND v.to_ref=p.id AND v.rel='evidence_of')");
  const invalid=()=>env.DB.db.exec(`INSERT INTO records VALUES('missing-proof','kept','${T}',NULL)`);
  if(state==='invalid')invalid();
  if(state==='concurrent'){
    const batch=env.DB.batch.bind(env.DB);let raced=false;
    env.DB.batch=async stmts=>{if(!raced){raced=true;invalid();}return batch(stmts);};
  }
  const result=await call();
  expect(result.status).toBe(state==='valid'?200:422);
  if(state!=='valid')expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
});

test('revoked creation caller is refused before data access',async()=>{
  const {env,request,call}=await setup();
  expect((await request('fixture-operator','/v1/tokens/revoke',{name:'fixture-caller'})).status).toBe(200);
  env.DB={prepare(){throw new Error('unexpected data access');}};
  expect((await call()).status).toBe(403);
});

test('request size and malformed UTF-8 are rejected before data access',async()=>{
  const {env,token,input}=await setup();env.DB={prepare(){throw new Error('unexpected data access');}};
  for(const body of [JSON.stringify({...input,values:{title:'x'.repeat(16384)}}),new Uint8Array([123,34,255,34,58,49,125])]){
    const response=await worker.fetch(new Request('https://hub.test/v1/rows/create',{method:'POST',headers:{Authorization:'Bearer '+token},body}),env,{waitUntil(){}});
    expect(response.status).toBe(400);
  }
});

test('creation remains capped before target data access',async()=>{
  const {env,token,input}=await setup();
  env.USAGE_LIMITS=JSON.stringify({d1_rows_read:{cap:1}});
  await ensureUsage(env.AUTH_DB);
  const now=new Date();
  env.AUTH_DB.db.query('INSERT INTO _usage(period,principal,rows_read,rows_written,requests,updated_at) VALUES(?,?,1,0,0,?)').run(period(now,1).start,'synthetic',now.toISOString());
  env.DB={prepare(){throw new Error('unexpected target data access');}};
  const pending=[];
  const response=await meteredWorker.fetch(new Request('https://hub.test/v1/rows/create',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(input)}),env,{waitUntil(p){pending.push(p);}});
  while(pending.length)await pending.shift();
  expect(response.status).toBe(429);
  expect((await response.json()).error).toBe('usage_cap');
});

test('HTTP creation capability and exact current grant create one target and origin',async()=>{
  const {env,input,request,token,call,policy}=await setup();
  const session=await request(token,'/v1/session',undefined,'GET');
  expect((await session.json()).capabilities.rowCreation).toEqual({protocol:'atomic-origin-v1',policies:[{id:'fixture',revision:policy.revision}]});
  const response=await call();expect(response.status).toBe(200);
  const receipt=await response.json();expect(receipt).toEqual({kind:'created',policy:input.policy,id:input.target.id,revision:{updated_at:T,hub_at:expect.any(String)},originId:`fixture-source:source-1:${input.target.id}`});
  expect(env.DB.db.query('SELECT title,updated_at FROM items').get()).toEqual({title:'initializer',updated_at:T});
  expect(env.DB.db.query('SELECT from_kind,from_ref,to_kind,to_ref,field,rel,asserted_by FROM provenance').get()).toEqual({from_kind:'fixture-source',from_ref:'source-1',to_kind:'items',to_ref:input.target.id,field:null,rel:'imported_from',asserted_by:config.namespace});
  expect(JSON.stringify(receipt)).not.toContain('private source title');
});
for(const deleted of [null,T])test('existing target, including tombstone, leaves all data untouched: '+deleted,async()=>{
  const {env,input,call}=await setup();
  env.DB.db.query('INSERT INTO items(id,title,updated_at,deleted_at) VALUES(?,?,?,?)').run(input.target.id,'completed prior task',T,deleted);
  env.DB.db.exec("INSERT INTO history(id,new) VALUES('prior','unchanged')");
  const before=snapshot(env.DB);
  const out=await call({...input,values:{title:null},updatedAt:'invalid'});
  expect(out.status).toBe(200);
  expect(await out.json()).toEqual({kind:'existing',policy:input.policy,id:input.target.id});
  expect(snapshot(env.DB)).toEqual(before);
});
test('adopted target is never computed or created when missing',async()=>{
  const {env,input,call}=await setup();
  const adopted={...input,target:{kind:'adopted',id:'adopted-target'}};
  let response=await call(adopted);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'adopted_missing'});
  expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
  env.DB.db.exec(`INSERT INTO items(id,title,updated_at,deleted_at) VALUES('adopted-target','kept','${T}','${T}')`);
  const before=snapshot(env.DB);response=await call(adopted);
  expect(await response.json()).toEqual({kind:'existing',policy:input.policy,id:'adopted-target'});
  expect(snapshot(env.DB)).toEqual(before);
});
test('grant cannot call old write/read/admin surfaces',async()=>{
  const {input,request,token}=await setup();
  for(const path of ['/v1/rows/insert','/v1/rows/push','/v1/rows/patch','/v1/rows/pull','/v1/derive','/v1/schema/push','/v1/tokens/create']) {
    expect((await request(token,path,{table:'items',columns:['id','title','updated_at'],rows:[{id:input.target.id,title:'x',updated_at:T}]})).status).toBe(403);
  }
});
for(const change of [
  x=>({...x,occurrenceKey:'2030'}),x=>({...x,target:{kind:'generated',id:'wrong'}}),
  x=>({...x,history:[]}),x=>({...x,origin:{asserted_by:'forged'}}),
  x=>({...x,values:{deleted_at:null}}),x=>({...x,sourceId:'\ud800'}),
])test('invalid identity or unauthorized fields fail before mutations: '+change.toString(),async()=>{
  const {env,input,call}=await setup();const response=await call(change(input));
  expect(response.status).toBe(400);expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
});
for(const sql of [
  "DELETE FROM sources",
  "UPDATE sources SET deleted_at='removed'",
  "INSERT INTO purges VALUES('purge','items','TARGET',NULL,NULL)",
  "INSERT INTO provenance(id) VALUES('fixture-source:source-1:TARGET')",
])test('source, purge and origin collision cannot leave partial creation: '+sql,async()=>{
  const {env,input,call}=await setup();env.DB.db.exec(sql.replaceAll('TARGET',input.target.id));const before=snapshot(env.DB);
  const response=await call();expect(response.status).toBeGreaterThanOrEqual(400);expect(snapshot(env.DB)).toEqual(before);
});
test('competing creation preserves winner and retry cannot attach origin',async()=>{
  const {env,input,call}=await setup(),batch=env.DB.batch.bind(env.DB);let raced=false;
  env.DB.batch=async statements=>{
    if(!raced){raced=true;env.DB.db.query('INSERT INTO items(id,title,updated_at) VALUES(?,?,?)').run(input.target.id,'winner',T);}
    return batch(statements);
  };
  expect((await call()).status).toBe(409);
  expect(await (await call()).json()).toEqual({kind:'existing',policy:input.policy,id:input.target.id});
  expect(env.DB.db.query('SELECT title FROM items').get()).toEqual({title:'winner'});
  expect(env.DB.db.query('SELECT * FROM provenance').all()).toEqual([]);
});
test('lost success acknowledgment retry leaves original origin attribution and rows intact',async()=>{
  const {env,input,call}=await setup();expect((await call()).status).toBe(200);const before=snapshot(env.DB);
  expect(await (await call()).json()).toEqual({kind:'existing',policy:input.policy,id:input.target.id});
  expect(snapshot(env.DB)).toEqual(before);
});

test('purged adopted physical row fails closed before existing acknowledgment',async()=>{
 const {env,input,call}=await setup();
 env.DB.db.query('INSERT INTO items(id,title,updated_at) VALUES(?,?,?)').run('adopted','stale physical row',T);
 env.DB.db.exec("INSERT INTO purges VALUES('purge','items','adopted',NULL,NULL)");
 const before=snapshot(env.DB),response=await call({...input,target:{kind:'adopted',id:'adopted'}});
 expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'adopted_missing'});expect(snapshot(env.DB)).toEqual(before);
});
for(const mutation of [
 "INSERT INTO purges VALUES('purge','items','TARGET',NULL,NULL)",
 "INSERT INTO purges VALUES('purge','sources','source-1',NULL,NULL)",
 "UPDATE sources SET deleted_at='removed' WHERE id='source-1'",
])test('guarded source or purge race rolls back complete creation: '+mutation,async()=>{
 const {env,input,call}=await setup(),batch=env.DB.batch.bind(env.DB);let raced=false;
 env.DB.batch=async statements=>{if(!raced){raced=true;env.DB.db.exec(mutation.replaceAll('TARGET',input.target.id));}return batch(statements);};
 const response=await call();expect(response.status).toBe(409);expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
});
test('case-insensitive source keys are unavailable, never normalized into duplicate identities',async()=>{
 const {env,call}=await setup();
 env.DB.db.exec(`DROP TABLE sources; CREATE TABLE sources(id TEXT PRIMARY KEY COLLATE NOCASE,title TEXT,updated_at TEXT,deleted_at TEXT); INSERT INTO sources VALUES('SOURCE-1','private','${T}',NULL)`);
 expect((await call()).status).toBe(503);expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
});
test('late origin invariant failure rolls target and helper state back',async()=>{
 const {env,call}=await setup();
 env.DB.db.exec("INSERT INTO catalog_rules(id,tbl,kind,enforce,scope,sql) VALUES('fail','provenance','invariant',1,'table','SELECT id FROM changed WHERE deleted_at IS NULL AND asserted_by LIKE ''%''')");
 expect((await call()).status).toBe(422);expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
 expect(env.DB.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});
test('policy replacement invalidates grant and advertised capability without data lookup',async()=>{
 const {env,input,token,request,call}=await setup();
 env.ROW_CREATION_POLICIES=JSON.stringify({fixture:{...config,columns:['title','extra']}});
 env.DB={prepare(){throw new Error('unexpected data lookup');}};
 expect((await call()).status).toBe(403);
 const session=await request(token,'/v1/session',undefined,'GET');expect((await session.json()).capabilities.rowCreation).toBeUndefined();
 const staleMint=await request('fixture-operator','/v1/tokens/create',{name:'stale',scopes:`rows:create:fixture:${input.policy.revision}`});
 expect(staleMint.status).toBe(400);
});
test('creation credentials never obtain governance, even with legacy authority rows or read grants',async()=>{
 const {env,request,token}=await setup(['tables:read:sources:id']);
 expect(env.AUTH_DB.db.query('SELECT * FROM _governance_authorities').all()).toEqual([]);
 env.AUTH_DB.db.exec("INSERT INTO _governance_authorities SELECT hash,'fixture-principal','user',1,1,NULL FROM _tokens");
 env.GOVERNANCE_DEPLOYMENT_ID='fixture-deployment';env.GOVERNANCE_PREVIEW_KEY='x'.repeat(64);
 const session=await request(token,'/v1/session',undefined,'GET');expect((await session.json()).capabilities.governance).toBeUndefined();
});
test('unconfigured, broad-only and absent grants cannot create or advertise a policy',async()=>{
 const {env,input,request}=await setup();
 expect((await request('fixture-operator','/v1/rows/create',input)).status).toBe(403);
 env.ROW_CREATION_POLICIES='{}';
 expect((await request('fixture-operator','/v1/rows/create',input)).status).toBe(403);
});

for(const column of ['HUB_AT','ID','Updated_At','CREATED_AT','DELETED_AT'])test('policy rejects case aliases of system initializer columns: '+column,async()=>{
 const policies=await creationPolicies({ROW_CREATION_POLICIES:JSON.stringify({fixture:{...config,columns:['title',column]}})});
 expect(policies).toEqual([]);
});
for(const column of ['rowid','_rowid_','oid','TITLE'])test('initializer must name an exact physical column: '+column,async()=>{
 const {env,request}=await setup();env.ROW_CREATION_POLICIES=JSON.stringify({fixture:{...config,columns:['title',column]}});
 const [p]=await creationPolicies(env);const mint=await request('fixture-operator','/v1/tokens/create',{name:'alias-caller',scopes:`rows:create:fixture:${p.revision}`});const {token}=await mint.json();
 const id=await creationId(config,'source-1',2030);
 const response=await request(token,'/v1/rows/create',{policy:{id:p.id,revision:p.revision},sourceId:'source-1',occurrenceKey:2030,target:{kind:'generated',id},updatedAt:T,values:{title:'safe',[column]:3}});
 expect(response.status).toBe(503);expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
});

for(const sourceId of ['001','9007199254740993'])test('origin storage affinity cannot reinterpret the exact source reference: '+sourceId,async()=>{
 const {env,input,call}=await setup();
 env.DB.db.exec('ALTER TABLE provenance RENAME TO old_provenance; CREATE TABLE provenance(id TEXT PRIMARY KEY,from_kind TEXT,from_ref INTEGER,to_kind TEXT,to_ref TEXT,field TEXT,rel TEXT,asserted_by TEXT,produced_at TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
 env.DB.db.query('INSERT INTO sources VALUES(?,?,?,NULL)').run(sourceId,'source-a',T);
 const changed={...input,sourceId,target:{kind:'generated',id:await creationId(config,sourceId,2030)}};
 const response=await call(changed);expect(response.status).toBe(503);expect(snapshot(env.DB)).toEqual({items:[],provenance:[],history:[]});
});

test('column NOCASE cannot acknowledge an aliased target behind a BINARY primary key',async()=>{
 const {env,input,call}=await setup();env.DB.db.exec('DROP TABLE items; CREATE TABLE items(id TEXT COLLATE NOCASE,title TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT,PRIMARY KEY(id COLLATE BINARY))');
 env.DB.db.query('INSERT INTO items(id,title,updated_at) VALUES(?,?,?)').run(input.target.id.toUpperCase(),'other byte identity',T);
 const before=snapshot(env.DB);const response=await call();expect(response.status).toBe(503);expect(snapshot(env.DB)).toEqual(before);
});
