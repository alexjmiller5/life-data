import { expect, test } from 'bun:test';
import worker from '../src/index.js';
import fixture from '../../tests/fixtures/hub-capabilities-contract.json';
import { D1Shim } from './d1shim.js';

async function setup(scopes, dataDb = null) {
  const env = {HUB_TOKEN:'operator-fixture',AUTH_DB:new D1Shim(),DB:dataDb ?? {prepare(){throw new Error('unexpected data access');}}};
  const ctx = {waitUntil(){}};
  const mint = await worker.fetch(new Request('https://hub.test/v1/tokens/create',{
    method:'POST',headers:{Authorization:'Bearer operator-fixture'},
    body:JSON.stringify({name:'consumer-fixture',scopes:scopes.join(',')}),
  }),env,ctx);
  const {token} = await mint.json();
  const call = (path,method='GET',body) => worker.fetch(new Request(`https://hub.test${path}`,{
    method,headers:{Authorization:`Bearer ${token}`},body:body === undefined ? undefined : JSON.stringify(body),
  }),env,ctx);
  return {call,env};
}

for (const entry of fixture.sessions) test(`session capability contract: ${entry.scopes.join(',')}`,async()=>{
  const {call} = await setup(entry.scopes);
  const response = await call('/v1/session');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({name:'consumer-fixture',scopes:entry.scopes,capabilities:entry.capabilities});
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('restricted schema denial is explicit and touches no data D1',async()=>{
  const {call} = await setup(['tables:read:articles']);
  for (const path of ['/v1/schema/pull','/v1/schema/push']) {
    const response = await call(path,'POST',{});
    expect(response.status).toBe(fixture.scoped_replica_unsupported.status);
    expect(await response.json()).toEqual(fixture.scoped_replica_unsupported.body);
  }
});

const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const revision = '2026-10-03T00:00:00.000Z';
function rowDb() {
  const db = new D1Shim();
  db.db.exec(`
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
    CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,created_at TEXT DEFAULT (${stamp}),updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE secrets(id TEXT PRIMARY KEY,value TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO articles(id,url,updated_at) VALUES ('a','https://example.test/a','${revision}');
    INSERT INTO secrets(id,value,updated_at) VALUES ('s','denied-value','${revision}');
    INSERT INTO catalog_tables VALUES ('articles','table',NULL),('secrets','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.url','articles','url','url'),('secrets.value','secrets','value','text');
  `);
  return db;
}
const pull = table => ({table,columns:['id','url'],since:'',limit:100});
const insert = (extra={}) => ({table:'articles',columns:['id','url','updated_at'],rows:[{id:'b',url:'https://example.test/b',updated_at:revision}],...extra});

test('table/body authorization precedes any data lookup and never interprets broad prefixes',async()=>{
  const {call} = await setup(['tables:read:articles','tables:write:articles']);
  for (const table of ['secrets','Articles','articles ','articles;SELECT 1','sqlite_master','history','provenance','catalog_properties','purges','_tokens',null,{}]) {
    for (const route of ['pull','insert','push']) expect((await call(`/v1/rows/${route}`,'POST',{...insert(),table})).status).toBe(403);
  }
  for (const [path,method] of [['/v1/catalog','GET'],['/v1/stats','POST'],['/v1/cursor','POST'],['/v1/backup','POST'],['/v1/archive/query','POST'],['/v1/derive','POST'],['/v1/tokens/list','POST'],['/v1/streams/anything','GET'],['/v1/files/captures/a','GET']]) {
    expect((await call(path,method,method==='POST'?{}:undefined)).status).toBe(403);
  }
});

test('narrow reads return only the permitted base table and bounded rows',async()=>{
  const db=rowDb(),{call}=await setup(['tables:read:articles'],db);
  const response=await call('/v1/rows/pull','POST',pull('articles'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({rows:[{id:'a',url:'https://example.test/a'}],next_cursor:null});
  expect((await call('/v1/rows/insert','POST',insert())).status).toBe(403);
  expect((await call('/v1/rows/pull','POST',{...pull('articles'),limit:201})).status).toBe(400);
  expect((await call('/v1/rows/pull','POST',{...pull('articles'),columns:['nonexistent']})).status).toBe(400);
});

test('narrow write grants allow insert and push without granting reads',async()=>{
  const db=rowDb(),{call}=await setup(['tables:write:articles'],db);
  const created=await call('/v1/rows/insert','POST',insert());
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({inserted:['b'],existing:[],rejected:[]});
  const changed=await call('/v1/rows/push','POST',insert({rows:[{id:'b',url:'https://example.test/c',updated_at:'2026-10-03T00:00:01.000Z'}]}));
  expect(changed.status).toBe(200);
  expect((await changed.json()).upserted).toBe(1);
  expect((await call('/v1/rows/pull','POST',pull('articles'))).status).toBe(403);
  expect(db.db.query("SELECT url FROM articles WHERE id='b'").get().url).toBe('https://example.test/c');
});

test('catalogued views, system tables and unregistered tables remain ineligible even with exact grants',async()=>{
  const db=rowDb();
  db.db.exec("CREATE VIEW visible AS SELECT id,value AS url,updated_at FROM secrets; INSERT INTO catalog_tables VALUES ('visible','table',NULL); CREATE TABLE plain(id TEXT PRIMARY KEY,updated_at TEXT); UPDATE catalog_tables SET kind='system' WHERE id='secrets'");
  const {call}=await setup(['tables:read:visible','tables:read:secrets','tables:read:plain','tables:read:history'],db);
  for(const table of ['visible','secrets','plain','history']) expect((await call('/v1/rows/pull','POST',pull(table))).status).toBe(403);
});

for(const [name,sql] of [
  ['side-effect trigger',"CREATE TRIGGER user_trigger AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END"],
  ['forged timestamp trigger',"CREATE TRIGGER articles_updated_at AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END"],
  ['unsafe default',"ALTER TABLE articles RENAME TO previous_articles; CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,updated_at TEXT,deleted_at TEXT,surprise TEXT DEFAULT (datetime('now')))"],
  ['generated expression',"ALTER TABLE articles ADD COLUMN surprise TEXT GENERATED ALWAYS AS (url || 'suffix') VIRTUAL"],
  ['SQL options',"UPDATE catalog_properties SET options_sql='SELECT value FROM secrets' WHERE tbl='articles'"],
  ['SQL catalog default',"UPDATE catalog_properties SET default_value='sql:SELECT value FROM secrets' WHERE tbl='articles'"],
  ['derived property',"UPDATE catalog_properties SET derived_by='http:fixture' WHERE tbl='articles'"],
  ['invariant',"INSERT INTO catalog_rules VALUES ('rule-secret','articles','invariant',1,'table','SELECT value FROM secrets',NULL)"],
  ['foreign key side effect',"CREATE TABLE child(id TEXT PRIMARY KEY,parent TEXT REFERENCES articles(id) ON DELETE CASCADE)"],
]) test(`narrow writes reject ${name} without leaking policy details`,async()=>{
  const db=rowDb();db.db.exec(sql);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
  expect(db.db.query("SELECT count(*) AS n FROM articles WHERE id='b'").get().n).toBe(0);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});

test('narrow history attachments are refused before reads and cannot attach denied-source events',async()=>{
  const {call}=await setup(['tables:write:articles']);
  expect((await call('/v1/rows/push','POST',insert({history:[]}))).status).toBe(403);
});

test('server validates internal references but returns only generic rejection',async()=>{
  const db=rowDb();db.db.exec("UPDATE catalog_properties SET type='ref',ref_table='secrets' WHERE tbl='articles'");
  const {call}=await setup(['tables:write:articles'],db);
  const invalid=await call('/v1/rows/insert','POST',insert({rows:[{id:'b',url:'absent',updated_at:revision}]}));
  expect(invalid.status).toBe(200);
  expect(await invalid.json()).toEqual({inserted:[],existing:[],rejected:[{id:'b',col:null,rule:'validation',message:'Row rejected.'}]});
  const valid=await call('/v1/rows/insert','POST',insert({rows:[{id:'c',url:'s',updated_at:revision}]}));
  expect((await valid.json()).inserted).toEqual(['c']);
});

test('a policy change between eligibility and commit cannot create side effects',async()=>{
  const db=rowDb(),batch=db.batch.bind(db);let changed=false;
  db.batch=async statements=>{
    if(!changed){changed=true;db.db.exec("CREATE TRIGGER concurrent_change AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END");}
    return batch(statements);
  };
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert());
  const body=await response.json();
  expect(response.status===403 || (response.status===200 && body.inserted.length===0 && body.rejected.length>0)).toBe(true);
  expect(JSON.stringify(body)).not.toContain('denied-value');
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

test('a base table replaced by a view before read is denied before the view runs',async()=>{
  const db=rowDb(),batch=db.batch.bind(db);let changed=false;
  db.batch=async statements=>{
    if(!changed){changed=true;db.db.exec('ALTER TABLE articles RENAME TO previous_articles; CREATE VIEW articles AS SELECT id,value AS url,updated_at FROM secrets');}
    return batch(statements);
  };
  const {call}=await setup(['tables:read:articles'],db);
  const response=await call('/v1/rows/pull','POST',pull('articles'));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'row request failed'});
});

test('canonical timestamp trigger is allowed, and narrow credentials revoke independently',async()=>{
  const db=rowDb();db.db.exec(`CREATE TRIGGER "articles_updated_at" AFTER UPDATE ON "articles" FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE "articles" SET updated_at = (${stamp}) WHERE rowid = NEW.rowid; END`);
  const {call,env}=await setup(['tables:write:articles'],db);
  expect((await (await call('/v1/rows/insert','POST',insert())).json()).inserted).toEqual(['b']);
  await env.AUTH_DB.prepare("UPDATE _tokens SET revoked_at='revoked' WHERE name='consumer-fixture'").run();
  expect((await call('/v1/rows/insert','POST',insert())).status).toBe(403);
  const other=await setup(['tables:read:articles'],db);
  expect((await other.call('/v1/rows/pull','POST',pull('articles'))).status).toBe(200);
});

test('narrow writes refuse a table with active purge recovery instead of running post-commit effects',async()=>{
  const db=rowDb();
  db.db.exec("CREATE TABLE purges(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,purged_at TEXT,deleted_at TEXT); INSERT INTO purges VALUES ('p','articles','b',NULL,'2099-01-01T00:00:00.000Z',NULL)");
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/push','POST',insert());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
});

test('narrow writes allow exact subscription triggers but reject a forged replacement',async()=>{
  const {createSubscription}=await import('../src/subscriptions.js');
  const db=rowDb();await createSubscription(db,{label:'Fixture',sources:[{table:'articles',columns:['url']}],start:'now'});
  const {call}=await setup(['tables:write:articles'],db);
  expect((await (await call('/v1/rows/insert','POST',insert())).json()).inserted).toEqual(['b']);
  expect(db.db.query('SELECT count(*) AS n FROM _change_events').get().n).toBe(1);
  const {name}=db.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_insert'").get();
  db.db.exec(`DROP TRIGGER "${name}"; CREATE TRIGGER "${name}" AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END`);
  expect((await call('/v1/rows/insert','POST',insert())).status).toBe(403);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});

for(const internal of ['_change_events','_change_subscriptions']) for(const concurrent of [false,true]) test(`outbox destination triggers cannot escape narrow grants: ${internal}, concurrent=${concurrent}`,async()=>{
  const {createSubscription}=await import('../src/subscriptions.js');
  const db=rowDb();await createSubscription(db,{label:'Fixture',sources:[{table:'articles',columns:['url']}],start:'now'});
  const sql=`CREATE TRIGGER escape_scope AFTER ${internal==='_change_events'?'INSERT':'UPDATE'} ON "${internal}" BEGIN UPDATE secrets SET value='escaped'; END`;
  if(concurrent) {
    const batch=db.batch.bind(db);let changed=false;
    db.batch=async statements=>{if(!changed){changed=true;db.db.exec(sql);}return batch(statements);};
  } else db.db.exec(sql);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert()),body=await response.json();
  expect(response.status===403 || (response.status===200 && body.inserted.length===0 && body.rejected.length>0)).toBe(true);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

for (const sideEffect of [false, true]) test(`legacy unquoted system timestamp trigger: side effect ${sideEffect}`, async () => {
  const db=rowDb();
  db.db.exec(`CREATE TABLE provenance(id TEXT PRIMARY KEY,updated_at TEXT);
    CREATE TRIGGER provenance_updated_at AFTER UPDATE ON provenance FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at BEGIN
      UPDATE provenance SET updated_at = (${stamp}) WHERE rowid = NEW.rowid;
      ${sideEffect ? "UPDATE secrets SET value='changed';" : ''}
    END`);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert());
  expect(response.status).toBe(sideEffect ? 403 : 200);
  expect(db.db.query("SELECT count(*) AS n FROM articles WHERE id='b'").get().n).toBe(sideEffect ? 0 : 1);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});
