import { expect, test } from 'bun:test';
import worker from '../src/index.js';
import { D1Shim } from './d1shim.js';

// provenance:create:<table> lets a narrow writer insert origin edges onto rows
// of its own write-granted table, and nothing else.
const revision='2026-10-09T00:00:00.000Z';
const options={
  from:"SELECT DISTINCT derived_by FROM catalog_properties WHERE derived_by IS NOT NULL AND deleted_at IS NULL",
  to:"SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'catalog!_%' ESCAPE '!' AND name NOT LIKE 'sqlite%' AND name != 'provenance'",
};
function edgeDb() {
  const db=new D1Shim();db.db.exec(`
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
    CREATE TABLE provenance(id TEXT PRIMARY KEY,to_kind TEXT,to_ref TEXT,field TEXT,from_kind TEXT,inputs_hash TEXT,value_hash TEXT,from_ref TEXT,produced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),deleted_at TEXT,hub_at TEXT,rel TEXT,detail TEXT,asserted_by TEXT);
    CREATE TABLE records(id TEXT PRIMARY KEY,title TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE secrets(id TEXT PRIMARY KEY,value TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO records VALUES ('r1','Live','${revision}',NULL,NULL),('r2','Gone','${revision}','${revision}',NULL);
    INSERT INTO secrets VALUES ('s1','denied-value','${revision}',NULL,NULL);
    INSERT INTO catalog_tables VALUES ('provenance','table',NULL),('records','table',NULL),('secrets','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type,required,options) VALUES
      ('records.title','records','title','text',NULL,NULL),('secrets.value','secrets','value','text',NULL,NULL),
      ('provenance.from_kind','provenance','from_kind','select',1,'[{"v":"takeout"}]'),
      ('provenance.to_kind','provenance','to_kind','select',1,'[]'),
      ('provenance.to_ref','provenance','to_ref','text',1,NULL),('provenance.from_ref','provenance','from_ref','text',1,NULL),
      ('provenance.rel','provenance','rel','select',1,'[{"v":"evidence_of"},{"v":"imported_from"},{"v":"derived_from"},{"v":"mentions"}]'),
      ('provenance.field','provenance','field','text',NULL,NULL),('provenance.detail','provenance','detail','json',NULL,NULL),
      ('provenance.asserted_by','provenance','asserted_by','text',1,NULL),('provenance.inputs_hash','provenance','inputs_hash','text',NULL,NULL);
  `);
  db.db.query("UPDATE catalog_properties SET options_sql=? WHERE id='provenance.from_kind'").run(options.from);
  db.db.query("UPDATE catalog_properties SET options_sql=? WHERE id='provenance.to_kind'").run(options.to);
  db.db.query('INSERT INTO catalog_rules VALUES (?,?,?,?,?,?,NULL)').run('guard','provenance','invariant',1,'table',
    "SELECT p.id FROM records p WHERE p.deleted_at IS NULL AND p.title='Kept' AND NOT EXISTS (SELECT 1 FROM provenance v WHERE v.deleted_at IS NULL AND v.to_kind='records' AND v.to_ref=p.id AND v.rel='evidence_of')");
  return db;
}
const grants=['tables:write:records','provenance:create:records'];
async function setup(scopes,db) {
  const env={HUB_TOKEN:'operator-fixture',AUTH_DB:new D1Shim(),DB:db},ctx={waitUntil(){}};
  const {token}=await (await worker.fetch(new Request('https://hub.test/v1/tokens/create',{method:'POST',
    headers:{Authorization:'Bearer operator-fixture'},body:JSON.stringify({name:'edge-writer',scopes:scopes.join(',')})}),env,ctx)).json();
  return (path,body)=>worker.fetch(new Request(`https://hub.test${path}`,{method:'POST',
    headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)}),env,ctx);
}
function edge(values={}) {
  const e={from_kind:'takeout',from_ref:'raw/source/1/',to_kind:'records',to_ref:'r1',rel:'imported_from',field:null,
    detail:'{"created_row":1}',asserted_by:'script:fixture',updated_at:revision,...values};
  return {id:`${e.from_kind}:${e.from_ref}:${e.to_kind}:${e.to_ref}`,...e};
}
const body=(...rows)=>({table:'provenance',columns:[...new Set(rows.flatMap(Object.keys))],rows});
const stored=db=>db.db.query('SELECT id,to_kind,to_ref,rel,field FROM provenance ORDER BY id').all();

test('an edge onto a live granted row is inserted once and never overwritten',async()=>{
  const db=edgeDb(),call=await setup(grants,db),e=edge();
  const created=await call('/v1/rows/insert',body(e));
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({inserted:[e.id],existing:[],rejected:[]});
  const again=await call('/v1/rows/insert',body({...e,rel:'evidence_of',updated_at:'2026-10-09T00:00:01.000Z'}));
  expect(await again.json()).toEqual({inserted:[],existing:[e.id],rejected:[]});
  expect(stored(db)).toEqual([{id:e.id,to_kind:'records',to_ref:'r1',rel:'imported_from',field:null}]);
});

test('a column evidence edge names a column of the granted table',async()=>{
  const db=edgeDb(),call=await setup(grants,db),e=edge({rel:'evidence_of',field:'title',detail:null});
  expect(await (await call('/v1/rows/insert',body(e))).json()).toEqual({inserted:[e.id],existing:[],rejected:[]});
});

test('catalog validation still applies, with a generic rejection',async()=>{
  const db=edgeDb(),call=await setup(grants,db);
  const out=await (await call('/v1/rows/insert',body(edge({from_kind:'bogus'})))).json();
  expect(out).toEqual({inserted:[],existing:[],rejected:[{id:edge({from_kind:'bogus'}).id,col:null,rule:'validation',message:'Row rejected.'}]});
  expect(stored(db)).toEqual([]);
});

for(const [name,request] of [
  ['derivation relation',body(edge({rel:'derived_from'}))],
  ['mention relation',body(edge({rel:'mentions'}))],
  ['ungranted target table',body(edge({to_kind:'secrets',to_ref:'s1'}))],
  ['provenance target',body(edge({to_kind:'provenance',to_ref:'x'}))],
  ['noncanonical id',body({...edge(),id:'photo:abc:people:p1'})],
  ['missing target row',body(edge({to_ref:'missing'}))],
  ['soft-deleted target row',body(edge({to_ref:'r2'}))],
  ['unknown field',body(edge({field:'value'}))],
  ['derivation hash column',body(edge({inputs_hash:'abc'}))],
  ['lifecycle column',body(edge({deleted_at:revision}))],
  ['created_at column',body(edge({created_at:revision}))],
  ['hub_at column',body(edge({hub_at:revision}))],
  ['nonstring target',body(edge({to_kind:1}))],
  ['one bad row in a batch',body(edge(),edge({to_kind:'secrets',to_ref:'s1'}))],
  ['history attachment',{...body(edge()),history:[]}],
  ['missing rel column',{...body(edge()),columns:Object.keys(edge()).filter(c=>c!=='rel')}],
  ['missing asserted_by',body(edge({asserted_by:''}))],
]) test(`edge denied: ${name}`,async()=>{
  const db=edgeDb(),call=await setup(grants,db);
  const response=await call('/v1/rows/insert',request);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
  expect(stored(db)).toEqual([]);
});

for(const route of ['push','patch','pull']) test(`edges are insert-only: ${route} denied`,async()=>{
  const db=edgeDb(),call=await setup(grants,db);
  const request=route==='pull'?{table:'provenance',columns:['id']}:route==='patch'
    ?{table:'provenance',id:edge().id,values:{rel:'evidence_of'},expected_revision:{updated_at:revision,hub_at:null}}:body(edge());
  expect((await call(`/v1/rows/${route}`,request)).status).toBe(403);
  expect(stored(db)).toEqual([]);
});

for(const scopes of [['provenance:create:records'],['tables:write:records'],['tables:write:secrets','provenance:create:records'],
  ['tables:write:records','provenance:create:secrets']]) test(`edge needs both exact grants: ${scopes}`,async()=>{
  const db=edgeDb(),call=await setup(scopes,db);
  expect((await call('/v1/rows/insert',body(edge()))).status).toBe(403);
});

test('a provenance trigger with side effects makes the grant unavailable',async()=>{
  const db=edgeDb();db.db.exec("CREATE TRIGGER leak AFTER INSERT ON provenance BEGIN UPDATE secrets SET value=NEW.to_ref; END");
  const call=await setup(grants,db);
  expect((await call('/v1/rows/insert',body(edge()))).status).toBe(403);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});

test('a provenance rule reading other edges is never confined to the edge writer',async()=>{
  const db=edgeDb();
  db.db.query('INSERT INTO catalog_rules VALUES (?,?,?,?,?,?,NULL)').run('edge-oracle','provenance','invariant',1,'table',
    "SELECT c.id FROM changed c WHERE c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM provenance p WHERE p.deleted_at IS NULL AND p.from_ref = c.from_ref AND p.to_kind <> c.to_kind)");
  const call=await setup(grants,db);
  expect((await call('/v1/rows/insert',body(edge()))).status).toBe(403);
  expect(stored(db)).toEqual([]);
});
