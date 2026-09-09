import { expect, test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { ROUTES } from '../src/index.js';
import { queryBudget } from '../src/write.js';

const T0 = '2025-01-01T00:00:00.000Z', T1 = '2025-01-02T00:00:00.000Z', T2 = '2025-01-03T00:00:00.000Z';
async function fresh(table = 'items') {
  const db = new D1Shim();
  db.db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, name TEXT, qty INTEGER, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, type TEXT, required INTEGER, sort INTEGER, options TEXT, inputs TEXT, deleted_at TEXT);
    CREATE TABLE catalog_rules (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, kind TEXT, enforce INTEGER, sql TEXT, text TEXT, deleted_at TEXT);
    CREATE TABLE history (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    INSERT INTO catalog_properties (id,tbl,col,type,required) VALUES ('name','${table}','name','text',1);`);
  return db;
}
const push = (db, rows, table = 'items') => ROUTES['/v1/rows/push']({ table, columns: [...new Set(rows.flatMap(Object.keys))], rows }, db);

test('F1: a real local numeric edit retains only its original event on acceptance and replay', async () => {
  const fixture = Bun.spawnSync(['python3','-B',`${import.meta.dir}/fixtures/numeric-history.py`], {
    env:{...process.env,PYTHONPATH:`${import.meta.dir}/../../src`},
  });
  expect(fixture.stderr.toString()).toBe('');
  expect(fixture.exitCode).toBe(0);
  const {body,results} = JSON.parse(fixture.stdout.toString());
  const original = body.history[0];
  const receipt = [{id:original.id,old:'1.0e-07',new:'2.0e-07',origin:'replica'}];
  const db = new D1Shim();
  db.db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, qty REAL, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    CREATE TABLE history (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);`);
  db.db.query('INSERT INTO items(id,qty,updated_at) VALUES (?,?,?)').run('a',1e-7,T0);
  for (let attempt=0; attempt<2; attempt++) {
    const out = await ROUTES['/v1/rows/push'](body,db);
    expect(out.upserted).toBe(1);
    expect(out.rejected).toEqual([]);
    const history = db.db.query('SELECT id,old,new,origin FROM history').all();
    expect(history).toEqual(receipt);
    expect({upserted:out.upserted,rejected:out.rejected,history}).toEqual(results[attempt]);
    expect(db.db.query('SELECT qty FROM items').get().qty).toBe(2e-7);
    expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
  }
});

for (const [type,initial,value] of [
  ['REAL','1',2], ['REAL','-1e20',2e20], ['REAL','1.234567890123456',1.234567890123457],
  ['INTEGER','1e-7',2e-7], ['NUMERIC','1.0',2], ['BLOB','4.0',5], ['REAL',"'not numeric'",1e-7],
]) test(`F1: native ${type} history ${initial} -> ${value}`, async () => {
  const db = new D1Shim();
  db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, qty ${type}, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    INSERT INTO items(id,qty,updated_at) VALUES ('a',${initial},'${T0}');`);
  const old = db.db.query('SELECT CAST(qty AS TEXT) AS v FROM items').get().v;
  // Store the JSON payload exactly as the push does, then capture native text.
  db.db.query('UPDATE items SET qty=json_extract(?,\'$.qty\')').run(JSON.stringify({qty:value}));
  const next = db.db.query('SELECT CAST(qty AS TEXT) AS v FROM items').get().v;
  db.db.exec(`UPDATE items SET qty=${initial}`);
  const original = {...event('numeric-edit',old,next),col:'qty'};
  const body = {table:'items',columns:['id','qty','updated_at'],rows:[{id:'a',qty:value,updated_at:T1}],history:[original]};
  for (let attempt=0; attempt<2; attempt++) {
    expect((await ROUTES['/v1/rows/push'](body,db)).rejected).toEqual([]);
    expect(db.db.query('SELECT id,old,new,origin FROM history').all()).toEqual([{id:original.id,old,new:next,origin:'replica'}]);
  }
});

for (const [stored,old] of [[3e-7,'1.0e-07'],[1e-7,'1e-7']]) test(`F1: numeric divergence is preserved for ${stored}/${old}`, async () => {
  const db = new D1Shim();
  db.db.exec('CREATE TABLE items(id TEXT PRIMARY KEY, qty REAL, updated_at TEXT, deleted_at TEXT, hub_at TEXT)');
  db.db.query('INSERT INTO items(id,qty,updated_at) VALUES (?,?,?)').run('a',stored,T0);
  const native = db.db.query('SELECT CAST(qty AS TEXT) AS old FROM items').get().old;
  const original = {...event('numeric-edit',old,'2.0e-07'),col:'qty'};
  const body = {table:'items',columns:['id','qty','updated_at'],rows:[{id:'a',qty:2e-7,updated_at:T1}],history:[original]};
  for (let attempt=0; attempt<2; attempt++) {
    expect((await ROUTES['/v1/rows/push'](body,db)).rejected).toEqual([]);
    expect(db.db.query('SELECT id FROM history WHERE origin=\'replica\'').all()).toEqual([{id:original.id}]);
    expect(db.db.query('SELECT old,new,origin FROM history WHERE origin<>\'replica\'').all()).toEqual([{old:native,new:'2.0e-07',origin:'hub:reconcile'}]);
  }
});

test('F1: native history planning stays bulk and budget exhaustion leaves no writes or helpers', async () => {
  const db = await fresh();
  const rows = Array.from({length:500},(_,i)=>({id:String(i),name:'item',qty:1e-7,updated_at:T0}));
  await push(db,rows);
  const history = rows.map(r=>({...event(`numeric-${r.id}`,'1.0e-07','2.0e-07'),row_id:r.id,col:'qty'}));
  const body = {table:'items',columns:Object.keys(rows[0]),rows:rows.map(r=>({...r,qty:2e-7,updated_at:T1})),history};
  for (const limit of [12,20,35]) {
    const out = await ROUTES['/v1/rows/push'](body,queryBudget(db,limit));
    expect(out.upserted).toBe(0);
    expect(out.rejected.length).toBe(500);
    expect(out.rejected.every(r=>r.rule==='write-budget')).toBe(true);
    expect(db.db.query('SELECT DISTINCT qty FROM items').all()).toEqual([{qty:1e-7}]);
    expect(db.db.query('SELECT * FROM history').all()).toEqual([]);
    expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
  }
  const prepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = sql => { count++; return prepare(sql); };
  const out = await ROUTES['/v1/rows/push'](body,db);
  expect(out.upserted).toBe(500);
  expect(out.rejected).toEqual([]);
  expect(count).toBeLessThan(75);
  console.info(`500-row numeric history: accepted=${out.upserted} rejected=${out.rejected.length} statements=${count}`);
  expect(db.db.query('SELECT id FROM history ORDER BY id').all()).toEqual(history.map(e=>({id:e.id})).sort((a,b)=>a.id.localeCompare(b.id)));
});

for (const stamp of ['', 'tomorrow', '2025-02-29T00:00:00.000Z', '2025-01-01T24:00:00.000Z', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00.000+00:00', 123, null]) {
  test(`protocol timestamp without a catalog: ${stamp}`, async () => {
    const db = new D1Shim();
    db.db.exec('CREATE TABLE raw (id TEXT PRIMARY KEY, updated_at TEXT)');
    const out = await push(db, [{id:'a', updated_at:stamp}], 'raw');
    expect(out.upserted).toBe(0);
    expect(out.rejected[0].col).toBe('updated_at');
    expect(db.db.query('SELECT * FROM raw').all()).toEqual([]);
  });
}

test('duplicate IDs validate evolving state', async () => {
  const db = await fresh();
  const out = await push(db, [{id:'a', name:'A', updated_at:T0}, {id:'a', qty:2, updated_at:T1}]);
  expect(out.rejected).toEqual([]);
  expect(db.db.query('SELECT name,qty FROM items').get()).toEqual({name:'A', qty:2});
});

test('invariants roll back values and history, valid siblings land, replay logs nothing', async () => {
  const db = await fresh();
  await push(db, [{id:'a', name:'A', qty:2, updated_at:T0}]);
  db.db.query("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('nondecreasing','items','invariant',1,?,'quantity cannot decrease')")
    .run('SELECT c.id FROM changed c JOIN before b USING(id) WHERE c.qty < b.qty');
  const out = await push(db, [{id:'a', qty:1, updated_at:T1}, {id:'b', name:'B', qty:3, updated_at:T1}]);
  expect(out.upserted).toBe(1);
  expect(out.rejected[0].rule).toBe('nondecreasing');
  expect(db.db.query("SELECT qty FROM items WHERE id='a'").get().qty).toBe(2);
  expect(db.db.query('SELECT * FROM history').all()).toEqual([]);
  expect((await push(db, [{id:'a', qty:4, updated_at:T2}])).rejected).toEqual([]);
  expect(db.db.query('SELECT col,old,new FROM history').all()).toEqual([{col:'qty',old:'2',new:'4'}]);
  await push(db, [{id:'a', qty:1, updated_at:T0}, {id:'a', qty:4, updated_at:T2}]);
  expect(db.db.query('SELECT * FROM history').all().length).toBe(1);
});

for (const table of ['changed', 'before', 'now']) test(`contexts preserve user table ${table}`, async () => {
  const db = await fresh(table);
  db.db.query("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('context',?,'invariant',1,?,'bad name')")
    .run(table, "SELECT id FROM changed WHERE name='bad' AND (SELECT ts FROM now) IS NOT NULL");
  const out = await push(db, [{id:'a', name:'bad', updated_at:T0}], table);
  expect(out.rejected[0].rule).toBe('context');
  expect(db.db.query(`SELECT * FROM "${table}"`).all()).toEqual([]);
});

test('concurrent edit between validation and write cannot approve a different merged row', async () => {
  const db = await fresh();
  await push(db, [{id:'a', name:'A', qty:2, updated_at:T0}]);
  const batch = db.batch.bind(db);
  let once = true;
  db.batch = async (statements) => {
    if (once) {
      once = false;
      db.db.query("UPDATE items SET name=NULL, updated_at=? WHERE id='a'").run(T1);
    }
    return batch(statements);
  };
  const out = await push(db, [{id:'a', qty:3, updated_at:T2}]);
  expect(out.upserted).toBe(0);
  expect(out.rejected.length).toBeGreaterThan(0);
  expect(db.db.query('SELECT qty FROM items').get().qty).toBe(2);
  expect(db.db.query('SELECT * FROM history').all()).toEqual([]);
});

test('500-row invariant pushes stay below 50 SQL statements for inserts and updates', async () => {
  const db = await fresh();
  db.db.query("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('positive','items','invariant',1,?,'positive quantity')")
    .run('SELECT id FROM changed WHERE qty < 0');
  const prepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = sql => { count++; return prepare(sql); };
  const rows = Array.from({length:500}, (_,i) => ({id:String(i), name:'item', qty:1, updated_at:T0}));
  let out = await push(db, rows);
  expect(out.upserted).toBe(500);
  expect(out.rejected).toEqual([]);
  console.info(`500-row bulk: accepted=${out.upserted} rejected=${out.rejected.length} statements=${count}`);
  expect(count).toBeLessThan(50);
  count = 0;
  out = await push(db, rows.map(r => ({...r, qty:2, updated_at:T1})));
  expect(out.upserted).toBe(500);
  expect(out.rejected).toEqual([]);
  console.info(`500-row bulk: accepted=${out.upserted} rejected=${out.rejected.length} statements=${count}`);
  expect(count).toBeLessThan(50);
});

test('a duplicate after an invariant rejection validates from real accepted state', async () => {
  const db = await fresh();
  db.db.exec('ALTER TABLE catalog_properties ADD COLUMN immutable INTEGER; UPDATE catalog_properties SET immutable=1');
  db.db.query("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('positive','items','invariant',1,?,'positive quantity')")
    .run('SELECT id FROM changed WHERE qty < 0');
  const out = await push(db, [{id:'a', name:'bad', qty:-1, updated_at:T0}, {id:'a', name:'good', qty:1, updated_at:T1}]);
  expect(out.upserted).toBe(1);
  expect(out.rejected.map(r=>r.rule)).toEqual(['positive']);
  expect(db.db.query('SELECT name FROM items').get().name).toBe('good');
});

test('concurrent catalog and reference changes invalidate validation', async () => {
  for (const change of ["UPDATE catalog_properties SET required=1 WHERE col='qty'", "UPDATE refs SET deleted_at='gone' WHERE id='r'"]) {
    const db = await fresh();
    db.db.exec("ALTER TABLE catalog_properties ADD COLUMN ref_table TEXT; CREATE TABLE refs (id TEXT, deleted_at TEXT); INSERT INTO refs VALUES ('r',NULL); INSERT INTO catalog_properties (id,tbl,col,type,ref_table) VALUES ('qty','items','qty','ref','refs');");
    const batch = db.batch.bind(db);
    db.batch = async statements => { db.db.exec(change); return batch(statements); };
    const row = change.includes('refs SET') ? {id:'a', name:'A', qty:'r', updated_at:T0} : {id:'a', name:'A', updated_at:T0};
    const out = await push(db, [row]);
    expect(out.upserted).toBe(0);
    expect(db.db.query('SELECT * FROM items').all()).toEqual([]);
  }
});

test('advisory rules stay advisory and tombstone values are not claims', async () => {
  const db = await fresh();
  db.db.exec("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('advice','items','invariant',0,'SELECT id FROM items','advice')");
  expect((await push(db, [{id:'a', name:'A', updated_at:T0}])).rejected).toEqual([]);
  const out = await push(db, [{id:'a', name:null, deleted_at:T1, updated_at:T1}]);
  expect(out.rejected).toEqual([]);
  expect(db.db.query('SELECT name,deleted_at FROM items').get()).toEqual({name:null,deleted_at:T1});
});

test('failure isolation has a bounded query budget and reports every uncommitted row', async () => {
  const db = await fresh();
  db.db.exec("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('deny','items','invariant',1,'SELECT id FROM changed','denied')");
  const prepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = sql => { count++; return prepare(sql); };
  const out = await push(db, Array.from({length:500}, (_,i) => ({id:String(i), name:'A', updated_at:T0})));
  expect(out.upserted).toBe(0);
  expect(new Set(out.rejected.map(r=>r.id)).size).toBe(500);
  expect(count).toBeLessThan(800);
  expect(out.rejected.some(r=>r.rule==='write-budget')).toBe(true);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});

test('invariants see final state after user AFTER triggers', async () => {
  const db = await fresh();
  db.db.exec("INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES ('positive','items','invariant',1,'SELECT id FROM changed WHERE qty < 0','positive'); CREATE TRIGGER change_qty AFTER INSERT ON items BEGIN UPDATE items SET qty=-1 WHERE id=NEW.id; END");
  const out = await push(db, [{id:'a',name:'A',qty:1,updated_at:T0}]);
  expect(out.upserted).toBe(0);
  expect(out.rejected[0].rule).toBe('positive');
  expect(db.db.query('SELECT * FROM items').all()).toEqual([]);
});

const event = (id, old, value) => ({id,tbl:'items',row_id:'a',col:'name',old,new:value,origin:'replica',created_at:T1,updated_at:T1});
for (const [old, value, events, extra] of [
  ['A','C',[event('e1','A','B'),event('e2','B','C')],[]],
  ['A','A',[event('e1','A','B'),event('e2','B','A')],[]],
  ['D','C',[event('e1','A','B'),event('e2','B','C')],[{old:'D',new:'C',origin:'hub:reconcile'}]],
  [null,'C',[event('e1','A','B'),event('e2','B','C')],[]],
]) test(`original history IDs survive coalesced edits ${old}->${value}`, async () => {
  const db = await fresh();
  if (old !== null) await push(db,[{id:'a',name:old,updated_at:T0}]);
  const body = {table:'items',columns:['id','name','updated_at'],rows:[{id:'a',name:value,updated_at:T2}],history:events};
  const out = await ROUTES['/v1/rows/push'](body,db);
  expect(out.rejected).toEqual([]);
  expect(db.db.query("SELECT id FROM history WHERE origin='replica' ORDER BY id").all()).toEqual([{id:'e1'},{id:'e2'}]);
  expect(db.db.query("SELECT old,new,origin FROM history WHERE origin<>'replica'").all()).toEqual(extra);
  await ROUTES['/v1/rows/push'](body,db);
  expect(db.db.query('SELECT * FROM history').all().length).toBe(events.length+extra.length);
});

test('SQL cannot commit a different row from the validated merged row', async () => {
  const db = await fresh();
  db.db.exec('CREATE TRIGGER clear_name AFTER INSERT ON items BEGIN UPDATE items SET name=NULL WHERE id=NEW.id; END');
  const out = await push(db, [{id:'a',name:'A',updated_at:T0}]);
  expect(out.upserted).toBe(0);
  expect(db.db.query('SELECT * FROM items').all()).toEqual([]);
});

test('stale rows import original unseen events without making hub history', async () => {
  const db = await fresh();
  await push(db,[{id:'a',name:'D',updated_at:T2}]);
  const out = await ROUTES['/v1/rows/push']({table:'items',columns:['id','name','updated_at'],rows:[{id:'a',name:'B',updated_at:T1}],history:[event('e1','A','B')]},db);
  expect(out.rejected).toEqual([]);
  expect(db.db.query('SELECT name FROM items').get().name).toBe('D');
  expect(db.db.query('SELECT id,origin FROM history').all()).toEqual([{id:'e1',origin:'replica'}]);
});

test('invariant rejection leaves neither attached events nor hub history', async () => {
  const db = await fresh();
  await push(db,[{id:'a',name:'A',updated_at:T0}]);
  db.db.exec("INSERT INTO catalog_rules VALUES ('deny','items',NULL,'invariant',1,'SELECT id FROM changed','denied',NULL)");
  const out = await ROUTES['/v1/rows/push']({table:'items',columns:['id','name','updated_at'],rows:[{id:'a',name:'B',updated_at:T1}],history:[event('e1','A','B')]},db);
  expect(out.rejected[0].rule).toBe('deny');
  expect(db.db.query('SELECT * FROM history').all()).toEqual([]);
  expect(db.db.query('SELECT name FROM items').get().name).toBe('A');
});

test('history IDs cannot be reused to rewrite original facts', async () => {
  const db = await fresh();
  const body = {table:'items',columns:['id','name','updated_at'],rows:[{id:'a',name:'B',updated_at:T1}],history:[event('e1','A','B')]};
  await ROUTES['/v1/rows/push'](body,db);
  const out = await ROUTES['/v1/rows/push']({...body,rows:[{id:'a',name:'C',updated_at:T2}],history:[event('e1','B','C')]},db);
  expect(out.rejected[0].rule).toBe('history');
  expect(db.db.query('SELECT name FROM items').get().name).toBe('B');
  expect(db.db.query('SELECT old,new FROM history').all()).toEqual([{old:'A',new:'B'}]);
});

for (const kind of ['ref','options']) test(`I1: earlier rows change ${kind} dependencies`, async () => {
  const db = await fresh();
  db.db.exec("ALTER TABLE items ADD COLUMN link TEXT; ALTER TABLE catalog_properties ADD COLUMN ref_table TEXT; ALTER TABLE catalog_properties ADD COLUMN options_sql TEXT;");
  const spec = kind === 'ref' ? "'ref','items',NULL" : "'select',NULL,'SELECT id FROM items WHERE deleted_at IS NULL'";
  db.db.exec(`INSERT INTO catalog_properties (id,tbl,col,type,ref_table,options_sql) VALUES ('link','items','link',${spec})`);
  await push(db,[{id:'a',name:'A',updated_at:T0},{id:'c',name:'C',updated_at:T0}]);
  const out = await push(db,[{id:'a',deleted_at:T1,updated_at:T1},{id:'b',name:'B',link:'a',updated_at:T1}]);
  expect(out.upserted).toBe(1);
  expect(out.rejected[0].rule).toBe(kind);
  expect(db.db.query("SELECT * FROM items WHERE id='b'").all()).toEqual([]);
  const created = await push(db,[{id:'d',name:'D',updated_at:T2},{id:'e',name:'E',link:'d',updated_at:T2}]);
  expect(created.rejected).toEqual([]);
  expect(created.upserted).toBe(2);
});

for (const derived of [false,true]) test(`I2: omitted defaults are validated, derived=${derived}`, async () => {
  const db = await fresh();
  db.db.exec("ALTER TABLE items ADD COLUMN choice TEXT DEFAULT 'bad'; ALTER TABLE catalog_properties ADD COLUMN derived_by TEXT;");
  db.db.exec(`INSERT INTO catalog_properties (id,tbl,col,type,options,derived_by,inputs) VALUES ('choice','items','choice','select','[{"v":"good"}]',${derived?"'http:demo'":"NULL"},'[]')`);
  if (derived) db.db.exec('CREATE TABLE provenance (id TEXT,inputs_hash TEXT,value_hash TEXT,deleted_at TEXT)');
  const out = await push(db,[{id:'a',name:'A',updated_at:T0}]);
  expect(out.upserted).toBe(0);
  expect(out.rejected.some(r=>r.rule===(derived?'provenance':'options'))).toBe(true);
  expect(db.db.query('SELECT * FROM items').all()).toEqual([]);
  if (!derived) {
    db.db.exec("UPDATE catalog_properties SET options='[{\"v\":\"bad\"}]' WHERE col='choice'");
    expect((await push(db,[{id:'a',name:'A',updated_at:T0}])).rejected).toEqual([]);
    expect(db.db.query('SELECT choice FROM items').get().choice).toBe('bad');
  }
});

test('I3: valid numeric strings retain SQLite INTEGER and REAL coercion', async () => {
  const db = await fresh();
  db.db.exec("ALTER TABLE items ADD COLUMN score REAL; INSERT INTO catalog_properties (id,tbl,col,type) VALUES ('qty','items','qty','int'),('score','items','score','number')");
  expect((await push(db,[{id:'a',name:'A',qty:'2',score:'2.5',updated_at:T0}])).rejected).toEqual([]);
  expect((await push(db,[{id:'a',qty:'3',score:'4',updated_at:T1}])).rejected).toEqual([]);
  expect(db.db.query('SELECT qty,score,typeof(qty) AS qt,typeof(score) AS st FROM items').get()).toEqual({qty:3,score:4,qt:'integer',st:'real'});
});

test('I4: ordered revisions consume original history without aggregate duplicates', async () => {
  const db = await fresh();
  await push(db,[{id:'a',name:'A',updated_at:T0}]);
  const out = await ROUTES['/v1/rows/push']({table:'items',columns:['id','name','updated_at'],rows:[{id:'a',name:'B',updated_at:T1},{id:'a',name:'C',updated_at:T2}],history:[event('e1','A','B'),event('e2','B','C')]},db);
  expect(out.upserted).toBe(2);
  expect(out.rejected).toEqual([]);
  expect(db.db.query('SELECT id FROM history ORDER BY id').all()).toEqual([{id:'e1'},{id:'e2'}]);
});

test('I7: schema-derived options do not conflict with our own read guards', async () => {
  const db = await fresh();
  db.db.exec("ALTER TABLE catalog_properties ADD COLUMN options_sql TEXT; UPDATE catalog_properties SET type='select', options_sql=\"SELECT name FROM sqlite_master WHERE type='table'\" WHERE col='name'");
  expect((await push(db,[{id:'a',name:'items',updated_at:T0}])).rejected).toEqual([]);
  expect(db.db.query('SELECT name FROM items').get().name).toBe('items');
});

for (const [values,revisions] of [['ABC','ABC'],['ABAB','ABAB'],['ABCBC','ABCBC'],['ABAC','ABAC'],['DBACACBADCB','DACACBCB']]) {
  for (const reverse of [false,true]) test(`I4 ordered/cyclic/coalesced ${values}/${revisions}, reversed=${reverse}`, async () => {
    const db=await fresh();
    await push(db,[{id:'a',name:values[0],updated_at:T0}]);
    const rows=[...revisions.slice(1)].map((name,i)=>({id:'a',name,updated_at:`2025-01-${String(i+2).padStart(2,'0')}T00:00:00.000Z`}));
    const history=[...values.slice(1)].map((value,i)=>event(`e${i}`,values[i],value));
    if (reverse) history.reverse();
    const body={table:'items',columns:Object.keys(rows[0]),rows,history};
    const out=await ROUTES['/v1/rows/push'](body,db);
    expect(out.upserted).toBe(rows.length);
    expect(out.rejected).toEqual([]);
    expect(db.db.query('SELECT name FROM items').get().name).toBe(revisions.at(-1));
    expect(db.db.query('SELECT id FROM history ORDER BY id').all()).toEqual(history.map(e=>({id:e.id})).sort((a,b)=>a.id.localeCompare(b.id)));
    expect((await ROUTES['/v1/rows/push'](body,db)).rejected).toEqual([]);
    expect(db.db.query('SELECT count(*) AS n FROM history').get().n).toBe(history.length);
  });
}

test('I4 one original cannot explain two distinct updates', async () => {
  const db=await fresh();
  await push(db,[{id:'a',name:'A',updated_at:T0}]);
  const rows=[...'BAB'].map((name,i)=>({id:'a',name,updated_at:`2025-01-0${i+2}T00:00:00.000Z`}));
  const out=await ROUTES['/v1/rows/push']({table:'items',columns:Object.keys(rows[0]),rows,history:[event('e1','A','B')]},db);
  expect(out.upserted).toBe(3);
  expect(out.rejected).toEqual([]);
  expect(db.db.query("SELECT old,new FROM history WHERE id<>'e1' ORDER BY created_at").all()).toEqual([{old:'B',new:'A'},{old:'A',new:'B'}]);
});

function ambiguousHistory() {
  // Many dead-end choices toward C. Even without a match, exhaustively proving
  // absence exceeds the matcher budget; that uncertainty cannot create a log.
  const history=[];
  for (let i=0;i<8;i++) {
    history.push(event(`start${i}`,'B',String(i)));
    for (let j=0;j<8;j++) if (i!==j) history.push(event(`edge${i}_${j}`,String(i),String(j)));
  }
  return history;
}

test('I4 matcher cap rejects all rows and original events atomically', async () => {
  const db=await fresh();
  await push(db,[{id:'a',name:'B',updated_at:T0}]);
  const rows=[{id:'sibling',name:'safe',updated_at:T1},{id:'a',name:'C',updated_at:T1},{id:'a',name:'D',updated_at:T2},{id:'suffix',name:'safe',updated_at:'invalid'}];
  const out=await ROUTES['/v1/rows/push']({table:'items',columns:Object.keys(rows[0]),rows,history:ambiguousHistory()},db);
  expect(out.upserted).toBe(0);
  expect(out.hub_at).toBe('');
  expect(out.rejected).toEqual(rows.map(row=>({id:row.id,col:null,rule:'history-ambiguity',retryable:true,message:'History matching budget exhausted; split revisions into smaller requests and retry.'})));
  expect(db.db.query('SELECT id,name FROM items').all()).toEqual([{id:'a',name:'B'}]);
  expect(db.db.query('SELECT * FROM history').all()).toEqual([]);
});

test('I4 history-bearing isolation keeps good rows and matches their actual sequence', async () => {
  const db=await fresh();
  await push(db,[{id:'a',name:'A',updated_at:T0}]);
  db.db.exec("INSERT INTO catalog_rules VALUES ('positive','items',NULL,'invariant',1,'SELECT id FROM changed WHERE qty<0','positive',NULL)");
  const rows=[{id:'a',name:'B',qty:1,updated_at:T1},{id:'bad',name:'bad',qty:-1,updated_at:T1},{id:'a',name:'C',qty:1,updated_at:T2}];
  const history=[event('e1','A','B'),event('e2','B','C')];
  const out=await ROUTES['/v1/rows/push']({table:'items',columns:Object.keys(rows[0]),rows,history},db);
  expect(out.upserted).toBe(2);
  expect(out.rejected.map(r=>[r.id,r.rule])).toEqual([['bad','positive']]);
  expect(db.db.query("SELECT id FROM history WHERE col='name' ORDER BY id").all()).toEqual([{id:'e1'},{id:'e2'}]);
  expect(db.db.query('SELECT id,name FROM items').all()).toEqual([{id:'a',name:'C'}]);
});

test('I4 a cap after a failed batch cannot leave an earlier isolated sibling committed', async () => {
  const db=await fresh();
  await push(db,[{id:'a',name:'A',updated_at:T0}]);
  db.db.exec("INSERT INTO catalog_rules VALUES ('positive','items',NULL,'invariant',1,'SELECT id FROM changed WHERE qty<0','positive',NULL)");
  const batch=db.batch.bind(db);
  let once=true;
  db.batch=async statements=> {
    try { return await batch(statements); }
    catch (e) {
      if (once) { once=false; db.db.exec("UPDATE items SET name='B' WHERE id='a'"); }
      throw e;
    }
  };
  const rows=[{id:'sibling',name:'safe',qty:1,updated_at:T1},{id:'bad',name:'bad',qty:-1,updated_at:T1},{id:'a',name:'C',qty:1,updated_at:T1}];
  const out=await ROUTES['/v1/rows/push']({table:'items',columns:Object.keys(rows[0]),rows,history:[...ambiguousHistory(),event('direct','A','C')]},db);
  expect(out.upserted).toBe(0);
  expect(out.rejected.map(r=>r.rule)).toEqual(rows.map(()=>'history-ambiguity'));
  expect(db.db.query('SELECT id,name FROM items').all()).toEqual([{id:'a',name:'B'}]);
  expect(db.db.query('SELECT * FROM history').all()).toEqual([]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});

test('N1 empty multi-column options preserve a permitted static value and first-column checks', async () => {
  const db=await fresh();
  db.db.exec("ALTER TABLE catalog_properties ADD COLUMN options_sql TEXT; CREATE TABLE option_values (code TEXT,label TEXT); UPDATE catalog_properties SET type='select',options='[{\"v\":\"ok\"}]',options_sql='SELECT code,label FROM option_values' WHERE col='name'");
  const out=await push(db,[{id:'a',name:'ok',updated_at:T0}]);
  expect(out.upserted).toBe(1);
  expect(out.rejected).toEqual([]);
  expect(db.db.query('SELECT id,name FROM items').all()).toEqual([{id:'a',name:'ok'}]);
  db.db.exec("INSERT INTO option_values VALUES ('dynamic','label-only')");
  const choices=await push(db,[{id:'b',name:'dynamic',updated_at:T1},{id:'c',name:'label-only',updated_at:T1}]);
  expect(choices.upserted).toBe(1);
  expect(choices.rejected.map(r=>[r.id,r.rule])).toEqual([['c','options']]);
});
