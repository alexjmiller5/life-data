import { expect, test } from 'bun:test';
import worker from '../src/main.js';
import { D1Shim } from './d1shim.js';

// Narrow readers repeat a table read cheaply: one cursor request per round,
// then incremental pages, many per request. Marks are answered only for tables
// the token may read with an arrival cursor: a whole-table grant, or column
// grants that include hub_at.
class Counting extends D1Shim {
  calls = 0;
  batching = false;
  prepare(sql) {
    const stmt = super.prepare(sql);
    for (const name of ['all', 'run', 'first', 'raw']) {
      const inner = stmt[name].bind(stmt);
      stmt[name] = async (...args) => { if (!this.batching) this.calls++; return inner(...args); };
    }
    return stmt;
  }
  async batch(stmts) {
    this.calls++;
    this.batching = true;
    try { return await super.batch(stmts); } finally { this.batching = false; }
  }
}

const at = s => `2026-10-03T00:00:0${s}.000Z`;
function rowDb() {
  const db = new Counting();
  db.db.exec(`
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE secrets(id TEXT PRIMARY KEY,value TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE legacy(id TEXT PRIMARY KEY,value TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE VIEW visible AS SELECT id,value AS url,updated_at,deleted_at,hub_at FROM secrets;
    INSERT INTO articles VALUES ('a','https://example.test/a','${at(1)}',NULL,'${at(1)}'),('b','https://example.test/b','${at(2)}',NULL,'${at(2)}'),('c','https://example.test/c','${at(2)}','${at(3)}','${at(2)}');
    INSERT INTO notes VALUES ('n','first','${at(1)}',NULL,'${at(4)}');
    INSERT INTO secrets VALUES ('s','denied-value','${at(1)}',NULL,'${at(9)}');
    INSERT INTO legacy VALUES ('l','v','${at(1)}',NULL);
    INSERT INTO catalog_tables VALUES ('articles','table',NULL),('notes','table',NULL),('secrets','table',NULL),('legacy','table',NULL),('visible','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.url','articles','url','url'),('notes.body','notes','body','text'),('secrets.value','secrets','value','text'),('legacy.value','legacy','value','text');
  `);
  return db;
}

async function setup(scopes, db = rowDb()) {
  const env = {HUB_TOKEN:'operator-fixture',AUTH_DB:new Counting(),DB:db};
  const ctx = {waitUntil(){}};
  const mint = await worker.fetch(new Request('https://hub.test/v1/tokens/create',{
    method:'POST',headers:{Authorization:'Bearer operator-fixture'},
    body:JSON.stringify({name:'consumer-fixture',scopes:scopes.join(',')}),
  }),env,ctx);
  const {token} = await mint.json();
  const call = async (path, body) => {
    const pending = [];
    const response = await worker.fetch(new Request(`https://hub.test${path}`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body),
    }),env,{waitUntil:p=>pending.push(p)});
    while (pending.length) await pending.shift();
    return response;
  };
  return {call,env,db};
}

const whole = ['tables:read:articles','tables:read:notes'];
const projected = ['id','url','deleted_at','hub_at'].map(c=>`tables:read:articles:${c}`);
const columns = ['id','url','deleted_at','hub_at'];

test('a whole-table reader gets marks for its own tables only, without the estate schema mark', async () => {
  const {call} = await setup(whole);
  const response = await call('/v1/cursor',{tables:['articles','notes']});
  expect(response.status).toBe(200);
  const marks = await response.json();
  expect(marks.tables).toEqual({articles:at(2),notes:at(4)});
  // Two articles share the newest arrival: a reader holding both is quiet.
  expect(marks.at_mark).toEqual({articles:2,notes:1});
  expect(marks.max_hub_at).toBe(at(4));
  expect(marks.pull_batch).toEqual({items:50,rows:5000,bytes:4*1024*1024});
  expect(marks.schema).toBeUndefined();
});

test('a column reader holding hub_at gets marks and incremental pulls', async () => {
  const {call} = await setup(projected);
  expect(await (await call('/v1/cursor',{tables:['articles']})).json()).toMatchObject({tables:{articles:at(2)},at_mark:{articles:2}});
  const page = await call('/v1/rows/pull',{table:'articles',columns,since:at(2),limit:10});
  expect(page.status).toBe(200);
  expect((await page.json()).rows.map(r=>r.id)).toEqual(['b','c']);
});

test('marks and arrival cursors stay closed to every table the token cannot read with hub_at', async () => {
  const cases = [
    [whole, {tables:['secrets']}],
    [whole, {tables:['articles','secrets']}],
    [whole, {tables:[]}],
    [whole, {}],
    [whole, {tables:'articles'}],
    [whole, {tables:['Articles']}],
    [whole, {tables:['history']}],
    [['tables:read:visible'], {tables:['visible']}],
    [projected.filter(s=>!s.endsWith(':hub_at')), {tables:['articles']}],
    [['tables:write:articles'], {tables:['articles']}],
  ];
  for (const [scopes, body] of cases) {
    const {call} = await setup(scopes);
    expect([403,400]).toContain((await call('/v1/cursor',body)).status);
  }
  // A column reader without hub_at still has no timestamp cursor.
  const {call} = await setup(projected.filter(s=>!s.endsWith(':hub_at')));
  expect((await call('/v1/rows/pull',{table:'articles',columns:['id','url'],since:at(1),limit:10})).status).toBe(403);
});

test('a table without an arrival column offers narrow readers no cursor', async () => {
  const {call} = await setup(['tables:read:legacy']);
  expect((await call('/v1/cursor',{tables:['legacy']})).status).toBe(400);
  expect((await call('/v1/rows/pull',{table:'legacy',columns:['id','value'],since:at(1),limit:10})).status).toBe(400);
});

test('a narrow batch pulls many tables, up to the batch row budget, in one request', async () => {
  const {call} = await setup(whole);
  const response = await call('/v1/rows/pull',{batch:[
    {table:'articles',columns,since:'',limit:2},
    {table:'notes',columns:['id','body'],since:at(4),limit:4998},
  ]});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({batch:[
    {rows:[{id:'a',url:'https://example.test/a',deleted_at:null,hub_at:at(1)},{id:'b',url:'https://example.test/b',deleted_at:null,hub_at:at(2)}],next_cursor:'b'},
    {rows:[{id:'n',body:'first'}],next_cursor:null},
  ]});
});

test('a narrow batch is authorized item by item before any data is read', async () => {
  const {call} = await setup(whole);
  for (const batch of [
    [{table:'articles',columns,since:'',limit:10},{table:'secrets',columns:['id','value'],since:'',limit:10}],
    [{table:'visible',columns:['id'],since:'',limit:10}],
  ]) expect((await call('/v1/rows/pull',{batch})).status).toBe(403);
  for (const batch of [
    [{table:'articles',columns,since:'',limit:5001}],
    [{table:'articles',columns,since:'',limit:3000},{table:'notes',columns:['id'],since:'',limit:3000}],
    [{table:'articles',columns:['id','nonexistent'],since:'',limit:10}],
    [],
  ]) expect((await call('/v1/rows/pull',{batch})).status).toBe(400);
});

// Every D1 call is a network round trip. A narrow reader's cursor and batch
// meet the full replica's warm-read budget (request-cost.test.js): the token
// batch, one table check, one guarded read, the usage flush.
for (const [path, body] of [
  ['/v1/cursor', {tables:['articles','notes']}],
  ['/v1/rows/pull', {batch:[{table:'articles',columns,since:at(2),limit:4990},{table:'notes',columns:['id'],since:'',limit:10}]}],
  ['/v1/rows/pull', {table:'articles',columns,since:at(2),limit:200}],
]) test(`a warm narrow ${path}${body.batch ? ' batch' : ''} answers within the replica read budget`, async () => {
  const {call,env} = await setup(whole);
  for (let i = 0; i < 2; i++) expect((await call(path,body)).status).toBe(200);
  env.DB.calls = env.AUTH_DB.calls = 0;
  expect((await call(path,body)).status).toBe(200);
  expect(env.DB.calls + env.AUTH_DB.calls).toBeLessThanOrEqual(4);
});

test('a table replaced by a view after its check fails the cursor and batch instead of answering for the view', async () => {
  for (const [path, body] of [['/v1/cursor',{tables:['articles']}],['/v1/rows/pull',{batch:[{table:'articles',columns,since:'',limit:10}]}]]) {
    const db = rowDb(), batch = db.batch.bind(db), prepare = db.prepare.bind(db), guarded = new WeakSet();
    let changed = false;
    db.prepare = sql => { const stmt = prepare(sql); if (sql.includes('life_write_conflict')) guarded.add(stmt); return stmt; };
    db.batch = async statements => {
      if (!changed && statements.some(s => guarded.has(s))) {
        changed = true;
        db.db.exec("ALTER TABLE articles RENAME TO previous_articles; CREATE VIEW articles AS SELECT id,value AS url,updated_at,deleted_at,hub_at FROM secrets");
      }
      return batch(statements);
    };
    const {call} = await setup(whole, db);
    const response = await call(path, body);
    expect(changed).toBe(true);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('denied-value');
  }
});

test('a checked read holding an unsafe integer still reads exactly after a prefetch', async () => {
  const db = rowDb();
  db.db.exec("ALTER TABLE catalog_tables ADD COLUMN big INTEGER; UPDATE catalog_tables SET big = 9007199254740993");
  const {call} = await setup(whole, db);
  expect((await call('/v1/rows/pull',{table:'articles',columns,since:'',limit:10})).status).toBe(200);
  expect((await call('/v1/cursor',{tables:['articles']})).status).toBe(200);
});
