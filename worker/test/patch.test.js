import { expect, test } from 'bun:test';
import worker from '../src/index.js';
import { D1Shim } from './d1shim.js';

const T0 = '2025-01-01T00:00:00.000Z';
function fresh() {
  const db = new D1Shim();
  db.db.exec(`
    CREATE TABLE items(id TEXT PRIMARY KEY,name TEXT,status TEXT,qty INTEGER,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,required INTEGER,sort INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,text TEXT,deleted_at TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_tables VALUES ('items','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type,required) VALUES ('name','items','name','text',1);
    INSERT INTO catalog_properties(id,tbl,col,type,options) VALUES ('status','items','status','select','[{"v":"open"},{"v":"closed"}]');
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('qty','items','qty','int');
    INSERT INTO items VALUES ('a','Original','open',1,'${T0}',NULL,'${T0}'),('b','Other','open',2,'${T0}',NULL,'${T0}');
  `);
  const env = {DB:db, AUTH_DB:new D1Shim(), HUB_TOKEN:'operator-fixture'};
  const call = (path, body, token='operator-fixture') => worker.fetch(new Request('https://hub.test'+path, {
    method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token},body:body===undefined?undefined:JSON.stringify(body),
  }),env,{waitUntil(){}});
  const patch = (extra={},token) => call('/v1/rows/patch',{
    table:'items',id:'a',values:{status:'closed'},expected_revision:{updated_at:T0,hub_at:T0},...extra,
  },token);
  return {db,env,call,patch};
}
const row = db => db.db.query("SELECT * FROM items WHERE id='a'").get();
const history = db => db.db.query('SELECT col,old,new FROM history ORDER BY col').all();

test('conditional edit commits a sparse change, revision and history through the HTTP endpoint', async () => {
  const {db,patch}=fresh();
  const response=await patch();
  const receipt=await response.json();
  expect({status:response.status,error:receipt.error}).toEqual({status:200,error:undefined});
  expect(receipt).toEqual({id:'a',revision:{updated_at:row(db).updated_at,hub_at:row(db).hub_at}});
  expect(receipt.revision.updated_at>T0).toBe(true);
  expect(row(db)).toMatchObject({name:'Original',status:'closed',qty:1,deleted_at:null});
  expect(db.db.query("SELECT status FROM items WHERE id='b'").get().status).toBe('open');
  expect(history(db)).toEqual([{col:'status',old:'open',new:'closed'}]);
});

test('replaying an accepted edit cannot overwrite a later edit or append history', async () => {
  const {db,patch}=fresh();
  expect((await patch()).status).toBe(200);
  const before=row(db),log=history(db);
  const retry=await patch({values:{name:'Retry'}});
  expect(retry.status).toBe(409);
  expect(await retry.json()).toEqual({error:'revision_conflict'});
  expect(row(db)).toEqual(before);
  expect(history(db)).toEqual(log);
});

for (const [name,sql] of [
  ['revision',"UPDATE items SET name='Concurrent',updated_at='2025-01-02T00:00:00.000Z' WHERE id='a'"],
  ['arrival',"UPDATE items SET hub_at='2025-01-02T00:00:00.000Z' WHERE id='a'"],
  ['deletion',"UPDATE items SET deleted_at='2025-01-02T00:00:00.000Z' WHERE id='a'"],
]) test('concurrent '+name+' between validation and commit wins',async()=>{
  const {db,patch}=fresh(),batch=db.batch.bind(db);
  let raced=false;
  db.batch=async statements=>{if(!raced){raced=true;db.db.exec(sql);}return batch(statements);};
  expect((await patch()).status).toBe(409);
  expect(row(db).status).toBe('open');
  expect(history(db)).toEqual([]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});

for (const change of [{id:'missing'},{expected_revision:{updated_at:T0,hub_at:null}}]) {
  test('missing or mismatched revision never creates or mutates rows: '+JSON.stringify(change),async()=>{
    const {db,patch}=fresh();
    expect((await patch(change)).status).toBe(409);
    expect(db.db.query('SELECT count(*) AS n FROM items').get().n).toBe(2);
    expect(row(db).status).toBe('open');
  });
}

test('a tombstone is not resurrected by an exact revision match',async()=>{
  const {db,patch}=fresh();db.db.exec(`UPDATE items SET deleted_at='${T0}' WHERE id='a'`);
  expect((await patch()).status).toBe(409);
  expect(row(db).deleted_at).toBe(T0);
});

test('future revisions still advance and are acknowledged with the committed clock',async()=>{
  const {db,patch}=fresh(),future='2099-01-01T00:00:00.000Z';
  db.db.query("UPDATE items SET updated_at=? WHERE id='a'").run(future);
  const response=await patch({expected_revision:{updated_at:future,hub_at:T0}});
  expect(response.status).toBe(200);
  const out=await response.json();
  expect(out.revision.updated_at>future).toBe(true);
  expect(out.revision.updated_at).toBe(row(db).updated_at);
  expect(row(db).status).toBe('closed');
});

for(const values of [{}, {id:'b'}, {updated_at:T0}, {created_at:T0}, {hub_at:T0}, {deleted_at:null}, {'name;DROP TABLE items':'x'}]) {
  test('invalid/structural patch fails before mutation: '+JSON.stringify(values),async()=>{
    const {db,patch}=fresh();const before=row(db);
    expect((await patch({values})).status).toBe(400);
    expect(row(db)).toEqual(before);expect(history(db)).toEqual([]);
  });
}

for(const values of [{status:'unknown'}, {name:null}, {qty:'invalid'}]) test('catalog rejection is atomic: '+JSON.stringify(values),async()=>{
  const {db,patch}=fresh();const before=row(db);
  expect((await patch({values})).status).toBe(422);
  expect(row(db)).toEqual(before);expect(history(db)).toEqual([]);
});

test('an invariant rejects the edit with no history or change event',async()=>{
  const {db,patch,call}=fresh();
  const sub=await call('/v1/subscriptions',{label:'Fixture',start:'now',sources:[{table:'items',columns:['status']}]});
  expect(sub.status).toBe(201);
  db.db.exec("INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text) VALUES ('positive','items','invariant',1,'SELECT id FROM changed WHERE qty < 0','positive quantity')");
  expect((await patch({values:{status:'closed',qty:-1}})).status).toBe(422);
  expect(row(db).status).toBe('open');expect(history(db)).toEqual([]);
  expect(db.db.query('SELECT count(*) AS n FROM _change_events').get().n).toBe(0);
});

test('exact table grants allow conditional edits without exposing other tables or row values',async()=>{
  const {db,env,call,patch}=fresh();
  const minted=await call('/v1/tokens/create',{name:'consumer',scopes:'tables:write:items'});
  const {token}=await minted.json();
  expect((await patch({table:'other'},token)).status).toBe(403);
  const response=await patch({},token);
  expect(response.status).toBe(200);
  const out=await response.json();
  expect(Object.keys(out).sort()).toEqual(['id','revision']);
  expect(row(db).status).toBe('closed');
  await env.AUTH_DB.prepare("UPDATE _tokens SET revoked_at='revoked' WHERE name='consumer'").run();
  expect((await patch({},token)).status).toBe(403);
});

test('read-only grants cannot edit and session capabilities advertise conditional editing',async()=>{
  const {call,patch}=fresh();
  const minted=await call('/v1/tokens/create',{name:'reader',scopes:'tables:read:items'});
  const {token}=await minted.json();
  expect((await patch({},token)).status).toBe(403);
  const session=await call('/v1/session',undefined,token);
  expect((await session.json()).capabilities.conditional_patch).toBe('revision-v1');
});

test('successful conditional edits publish one durable event and rejected retries publish none',async()=>{
  const {db,call,patch}=fresh();
  expect((await call('/v1/subscriptions',{label:'Fixture',start:'now',sources:[{table:'items',columns:['status']}]})).status).toBe(201);
  expect((await patch()).status).toBe(200);
  expect((await patch()).status).toBe(409);
  const events=db.db.query('SELECT payload_json FROM _change_events').all().map(r=>JSON.parse(r.payload_json));
  expect(events).toHaveLength(1);
  expect(events[0].changes).toEqual([{column:'status',old_value:'open',new_value:'closed'}]);
  expect(events[0].source.after_revision).toEqual({updated_at:row(db).updated_at,hub_at:row(db).hub_at});
});

test('a suppressed mutation cannot produce a successful receipt or history',async()=>{
  const {db,patch}=fresh();
  db.db.exec("CREATE TRIGGER ignore_edit BEFORE UPDATE ON items BEGIN SELECT RAISE(IGNORE); END");
  expect((await patch()).status).toBe(409);
  expect(row(db).status).toBe('open');
  expect(history(db)).toEqual([]);
});

test('table policy changed before commit cannot redirect a narrow edit',async()=>{
  const {db,call,patch}=fresh();
  db.db.exec("CREATE TABLE private_rows(id TEXT PRIMARY KEY,value TEXT); INSERT INTO private_rows VALUES ('hidden','kept')");
  const minted=await call('/v1/tokens/create',{name:'consumer',scopes:'tables:write:items'});
  const {token}=await minted.json();
  const batch=db.batch.bind(db);let raced=false;
  db.batch=async statements=>{if(!raced){raced=true;db.db.exec("CREATE TRIGGER malicious AFTER UPDATE ON items BEGIN UPDATE private_rows SET value='overwritten'; END");}return batch(statements);};
  expect((await patch({},token)).status).toBe(409);
  expect(db.db.query('SELECT value FROM private_rows').get().value).toBe('kept');
  expect(row(db).status).toBe('open');
});
