import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import rules from '../../tests/fixtures/table-invariants.json';
import { schema, setup, TestSql, T0, T1 } from './support.ts';

type Statement = core.SqlReadStatement;
type Inspectable = TestSql & Pick<core.SqlDriver, 'readDependencies'>;
const databases: { close(): void }[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(rule = rules[0]) {
  const result = setup();
  databases.push(result.db.db, result.remote.db);
  const { remote } = result;
  const ddl = schema[0].replaceAll('items', 'limits');
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  for (const [col, type] of [['name','text'],['qty','int']]) remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run(`items.${col}`,'items',col,type,T0,T1);
  remote.db.query('INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text,updated_at,hub_at) VALUES (?,?,?,?,?,?,?,?)').run(rule.id,'items','invariant',1,rule.sql,rule.text,T0,T1);
  remote.db.query('INSERT INTO items(id,name,qty,created_at,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('edited','Initial',2,T0,T0,T1);
  remote.db.query('INSERT INTO limits(id,qty,updated_at,hub_at) VALUES (?,?,?,?)').run('cap',5,T0,T1);
  return { ...result, db: result.db as Inspectable };
}

// Bun's SQLite adapter has no public compiler-read hook. These core tests inject
// explicit metadata at that boundary, but prepare every supplied SQL statement
// against the real connection. Shared host fixtures test metadata discovery.
function inspect(db: Inspectable, tables: string[] | null = ['items']) {
  const calls: Statement[][] = [];
  db.readDependencies = async (statements, context) => {
    expect(context).toEqual({ ownedTempTables: ['_core_write_before'] });
    calls.push(statements.map(s => ({ ...s })));
    for (const { sql, params = [] } of statements) {
      const statement = db.db.prepare(sql);
      try { expect(statement.paramsCount).toBe(params.length); }
      finally { statement.finalize(); }
    }
    return tables === null ? null : { tables };
  };
  return calls;
}

async function blocked(db: Inspectable, rule = 'coverage') {
  const rows = await db.all('SELECT * FROM items');
  const history = await db.all('SELECT * FROM history');
  const status = await core.syncStatus(db);
  const advisory = await core.writeability(db, { table: 'items' });
  expect(advisory.writable).toBe(false);
  expect(advisory.reason?.rule).toBe(rule);
  try { await core.writeRow(db, 'items', { id: 'edited', name: 'Changed' }); throw new Error('write should reject'); }
  catch (error) {
    expect(error).toBeInstanceOf(core.ValidationError);
    expect((error as core.ValidationError).violations[0]).toMatchObject({ ...advisory.reason!, row_id: 'edited' });
  }
  expect(await db.all('SELECT * FROM items')).toEqual(rows);
  expect(await db.all('SELECT * FROM history')).toEqual(history);
  expect(await core.syncStatus(db)).toEqual(status);
}

test('a compiler-verified self rule writes and round trips while unrelated tables stay skipped', async () => {
  const { db, hub, remote } = fixture();
  await core.sync(db, hub, { tables: { history: false, limits: false } });
  inspect(db);
  expect(await core.writeability(db, { table: 'items' })).toEqual({ writable: true, reason: null });
  const written = await core.writeRow(db, 'items', { id: 'edited', qty: 4 });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect((await core.sync(db, hub, { tables: { history: false, limits: false } })).rejected).toEqual([]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query("SELECT qty FROM items WHERE id='edited'").get()).toEqual({ qty: 4 });
  const other = new TestSql(); databases.push(other.db);
  await core.sync(other, hub);
  expect((await other.all("SELECT * FROM items WHERE id='edited'"))[0]).toMatchObject({ ...written, hub_at: expect.any(String) });
  expect(await other.all('SELECT id,col,old,new FROM history ORDER BY id')).toEqual(await db.all('SELECT id,col,old,new FROM history ORDER BY id'));
});

test('missing compiler capability retains the global coverage gate', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub, { tables: { history: false } });
  await blocked(db);
  await core.sync(db, hub);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test.each([null, { tables: ['unknown'] }, { tables: ['_core_state'] }, {}, { tables: 'items' }])('unsupported or malformed metadata never grants coverage: %j', async result => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  db.readDependencies = async () => result as { tables: string[] } | null;
  await blocked(db);
});

test('a new cross-table dependency requires its proof and a full backfill', async () => {
  const { db, hub, requests } = fixture();
  await core.sync(db, hub, { tables: { limits: false, history: false } });
  inspect(db);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  await db.run('UPDATE catalog_rules SET sql=?', [rules.find(r => r.id === 'cross-table')!.sql]);
  inspect(db, ['items','limits']);
  await blocked(db);
  expect((await core.writeability(db, { table: 'items' })).reason?.message).toContain('limits');
  requests.length = 0;
  await core.sync(db, hub, { tables: { limits: true, history: false } });
  expect(requests.find(r => r.route === '/v1/rows/pull' && r.body.table === 'limits')!.body.since).toBe('');
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test('inspection sees a fresh empty owned snapshot and exactly the wrapper later executed', async () => {
  const { db, hub } = fixture(rules.find(r => r.id === 'nondecreasing')!);
  await core.sync(db, hub);
  const calls = inspect(db);
  const metadata = db.readDependencies!;
  db.readDependencies = async (statements, context) => {
    expect(await db.all('SELECT * FROM temp._core_write_before')).toEqual([]);
    return metadata(statements, context);
  };
  const all = db.all.bind(db);
  const executed: string[] = [];
  db.all = async (sql, params) => {
    if (sql.startsWith('WITH changed AS')) executed.push(sql);
    return all(sql, params);
  };
  await core.writeability(db, { table: 'items' });
  expect(executed).toEqual([]);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
  await core.writeRow(db, 'items', { id: 'edited', qty: 4 });
  expect(calls).toHaveLength(2);
  expect(calls[0][0].sql).toBe(calls[1][0].sql);
  expect(executed).toEqual([calls[0][0].sql]);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
  await expect(core.writeRow(db, 'items', { id: 'edited', qty: 1 })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
});

test.each(['table', 'view'])('a pre-existing TEMP %s is never adopted or dropped as a write snapshot', async kind => {
  const { db, hub } = fixture(); await core.sync(db, hub); inspect(db);
  await db.run(kind === 'table' ? 'CREATE TEMP TABLE _core_write_before AS SELECT 42 AS keep'
    : 'CREATE TEMP VIEW _core_write_before AS SELECT 42 AS keep');
  await blocked(db, 'context');
  expect(await db.all('SELECT * FROM temp._core_write_before')).toEqual([{ keep: 42 }]);
});

test.each(['options', 'default', 'ref', 'multi_ref'])('%s validation dependencies require proof even when an individual patch could avoid the property', async kind => {
  const { db, hub } = fixture();
  await core.sync(db, hub, { tables: { limits: false, history: false } });
  if (kind === 'options') await db.run("UPDATE catalog_properties SET options_sql='SELECT id FROM limits' WHERE col='name'");
  else if (kind === 'default') await db.run("UPDATE catalog_properties SET default_value='sql:(SELECT id FROM limits LIMIT 1)' WHERE col='name'");
  else await db.run("UPDATE catalog_properties SET type=?,ref_table='limits' WHERE col='name'", [kind]);
  const calls = inspect(db, kind === 'ref' || kind === 'multi_ref' ? ['items'] : ['items','limits']);
  await blocked(db);
  if (kind === 'options') expect(calls[0]).toContainEqual({ sql: 'SELECT * FROM (SELECT id FROM limits)' });
  if (kind === 'default') expect(calls[0]).toContainEqual({ sql: 'SELECT ((SELECT id FROM limits LIMIT 1)) AS value' });
  await core.sync(db, hub, { tables: { limits: true, history: false } });
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test('SQL defaults and options are inspected again after catalog edits, without executing them during advisory', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub, { tables: { history: false, limits: false } });
  const calls = inspect(db);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  await db.run("UPDATE catalog_properties SET default_value='sql:json(''not-json'')',options_sql='SELECT json(''not-json'')' WHERE col='name'");
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  expect(calls[1]).toContainEqual({ sql: "SELECT (json('not-json')) AS value" });
  expect(calls[1]).toContainEqual({ sql: "SELECT * FROM (SELECT json('not-json'))" });
  await expect(core.writeRow(db, 'items', { qty: 4 })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
  expect((await db.all('SELECT count(*) AS n FROM items'))[0].n).toBe(1);
});

test.each(['items','catalog_properties','catalog_rules','catalog_tables'])('empty metadata cannot bypass mandatory %s proof', async table => {
  const { db, hub, remote } = fixture();
  const ddl = schema[0].replaceAll('items', 'catalog_tables');
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  await core.sync(db, hub);
  inspect(db, []);
  await db.run('DELETE FROM _core_coverage WHERE tbl=?', [table]);
  await blocked(db);
});

test('ordinary standalone writes with defaults, options and references do not acquire a new coverage requirement', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  await db.run('DELETE FROM catalog_rules');
  await db.run('DELETE FROM _core_coverage');
  await db.run('DELETE FROM _core_state');
  await db.run("DELETE FROM _sync_state WHERE key='hub_url'");
  await db.run("UPDATE catalog_properties SET type='ref',ref_table='limits',default_value='sql:(SELECT id FROM limits)',options_sql='SELECT id FROM limits' WHERE col='name'");
  db.readDependencies = async () => { throw new Error('Must not inspect tables without invariants'); };
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  expect(await core.writeRow(db, 'items', { qty: 4 }, { id: () => 'new' })).toMatchObject({ id: 'new', name: 'cap' });
});

test.each(['throw', 'null', 'cleanup'])('inspection %s failure rolls back only the snapshot core owns', async failure => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  const schemaBefore = await db.all('SELECT * FROM main.sqlite_master ORDER BY name');
  const logBefore = await db.all('SELECT * FROM _schema_log');
  inspect(db);
  if (failure === 'throw') db.readDependencies = async () => { throw new Error('Private SQL diagnostic'); };
  if (failure === 'null') db.readDependencies = async () => null;
  if (failure === 'cleanup') {
    const run = db.run.bind(db);
    db.run = async (sql, params) => { if (sql === 'DROP TABLE temp._core_write_before') throw new Error('cleanup failed'); return run(sql, params); };
  }
  await blocked(db, failure === 'cleanup' ? 'storage' : 'coverage');
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
  expect(await db.all('SELECT * FROM main.sqlite_master ORDER BY name')).toEqual(schemaBefore);
  expect(await db.all('SELECT * FROM _schema_log')).toEqual(logBefore);
});

test.each([
  "UPDATE _core_coverage SET endpoint='https://other.test' WHERE tbl='items'",
  "UPDATE _core_coverage SET version=0 WHERE tbl='items'",
  "UPDATE _core_sync SET pull='2100-01-01T00:00:00.000Z' WHERE tbl='items'",
  "UPDATE _core_state SET value='refreshing' WHERE key='coverage_phase'",
  'ALTER TABLE items ADD COLUMN extra TEXT',
])('narrowing retains binding, readiness, schema and checkpoint guards: %s', async sql => {
  const { db, hub } = fixture(); await core.sync(db, hub); inspect(db);
  await db.run(sql);
  await blocked(db);
});

test.each(rules)('narrowed single-row invariant $id still rejects, rolls back and survives a real hub round trip', async rule => {
  const { db, hub } = fixture(rule);
  await core.sync(db, hub, { tables: { history: false } });
  inspect(db, rule.id === 'cross-table' ? ['items','limits'] : ['items']);
  const before = await db.all('SELECT * FROM items');
  await expect(core.writeRow(db, 'items', { id: 'edited', ...rule.blocked })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  await core.writeRow(db, 'items', { id: 'edited', ...rule.allowed });
  expect((await core.sync(db, hub, { tables: { history: false } })).rejected).toEqual([]);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
});

test('oversized dependency SQL fails closed before calling the adapter', async () => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  await db.run('UPDATE catalog_rules SET sql=?', [`SELECT id FROM changed WHERE 0 /*${'x'.repeat(524_288)}*/`]);
  let calls = 0;
  db.readDependencies = async () => { calls++; return { tables: ['items'] }; };
  await blocked(db);
  expect(calls).toBe(0);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
});

test('too many preparation statements fail closed before calling the adapter', async () => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  for (let i=0;i<128;i++) await db.run("INSERT INTO catalog_rules(id,tbl,kind,enforce,sql) VALUES (?,'items','invariant',1,?)", [`extra${i}`,`SELECT id FROM changed WHERE qty<0 /*${i}*/`]);
  let calls = 0;
  db.readDependencies = async () => { calls++; return { tables: ['items'] }; };
  await blocked(db);
  expect(calls).toBe(0);
});

test('actual history reads require history coverage while unrelated proof remains unnecessary', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub, { tables: { history: false, limits: false } });
  await db.run("UPDATE catalog_rules SET sql='SELECT id FROM changed WHERE (SELECT count(*) FROM history)>100'");
  inspect(db, ['items','history']);
  await blocked(db);
  await core.sync(db, hub, { tables: { history: true, limits: false } });
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  await core.writeRow(db, 'items', { id: 'edited', qty: 4 });
});

test('narrowed insert contexts stay empty before mutation and retain pending receipts', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub, { tables: { history: false, limits: false } });
  await db.run("UPDATE catalog_rules SET sql='SELECT id FROM changed WHERE (SELECT count(*) FROM before)!=0 OR qty<0'");
  inspect(db);
  await core.writeRow(db, 'items', { name: 'Created', qty: 4 }, { id: () => 'new' });
  await expect(core.writeRow(db, 'items', { name: 'Rejected', qty: -1 }, { id: () => 'bad' })).rejects.toBeInstanceOf(core.ValidationError);
  expect((await db.all('SELECT id FROM items ORDER BY id')).map(r => r.id)).toEqual(['edited','new']);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect((await core.sync(db, hub, { tables: { history: false, limits: false } })).rejected).toEqual([]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
});

test.each(['trigger', 'foreign_key', 'invariant'])('compiler metadata cannot bypass the %s effect guard', async guard => {
  const { db, hub } = fixture(); await core.sync(db, hub); inspect(db);
  if (guard === 'trigger') await db.run('CREATE TRIGGER custom AFTER UPDATE ON items BEGIN UPDATE limits SET qty=100; END');
  if (guard === 'foreign_key') await db.run('CREATE TABLE child(id TEXT,parent TEXT REFERENCES items(id))');
  if (guard === 'invariant') {
    await db.run('ALTER TABLE catalog_rules ADD COLUMN scope TEXT');
    await db.run("UPDATE catalog_rules SET scope='estate'");
  }
  await blocked(db, guard);
  expect(await db.all('SELECT name FROM temp.sqlite_master')).toEqual([]);
});
