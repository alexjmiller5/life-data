import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import rules from '../../tests/fixtures/table-invariants.json';
import { schema, setup, TestSql, T0, T1, T2 } from './support.ts';

const databases: { close(): void }[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(rule = rules[0]) {
  const result = setup();
  databases.push(result.db.db, result.remote.db);
  const { remote } = result;
  const ddl = schema[0].replaceAll('items', 'limits');
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.name','items','name','text',T0,T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.qty','items','qty','int',T0,T1);
  remote.db.query('INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text,updated_at,hub_at) VALUES (?,?,?,?,?,?,?,?)').run(rule.id,'items','invariant',1,rule.sql,rule.text,T0,T1);
  for (const [id, qty] of [['edited',2], ['untouched',7]] as const) remote.db.query('INSERT INTO items(id,name,qty,created_at,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run(id,'Initial',qty,T0,T0,T1);
  remote.db.query('INSERT INTO limits(id,qty,updated_at,hub_at) VALUES (?,?,?,?)').run('cap',5,T0,T1);
  return result;
}
async function blocked(db: TestSql, rule: string, patch: core.Row = { id: 'edited', name: 'New' }) {
  const before = await db.all('SELECT * FROM items ORDER BY id');
  const history = await db.all('SELECT * FROM history');
  const pending = await core.syncStatus(db);
  const advisory = await core.writeability(db, { table: 'items' });
  expect(advisory.writable).toBe(false);
  expect(advisory.reason?.rule).toBe(rule);
  let error: unknown;
  try { await core.writeRow(db, 'items', patch); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(core.ValidationError);
  expect((error as core.ValidationError).violations[0]).toMatchObject({ ...advisory.reason!, row_id: String(patch.id ?? '') || null });
  expect(await db.all('SELECT * FROM items ORDER BY id')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual(history);
  expect(await core.syncStatus(db)).toEqual(pending);
}

test.each(rules)('single-row invariant $id agrees through origin, real Worker and a second replica', async rule => {
  const { db, remote, hub } = fixture(rule);
  await core.sync(db, hub);
  const before = await db.all("SELECT * FROM items WHERE id='edited'");
  try { await core.writeRow(db, 'items', { id: 'edited', ...rule.blocked }); throw new Error('write should reject'); }
  catch (error) {
    expect(error).toBeInstanceOf(core.ValidationError);
    expect((error as core.ValidationError).violations).toEqual([{ tbl: 'items', row_id: 'edited', col: '', rule: rule.id, message: rule.text }]);
  }
  expect(await db.all("SELECT * FROM items WHERE id='edited'")).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  const stamp = new Date().toISOString();
  const invalidRemote: core.Row = { ...before[0], ...rule.blocked, updated_at: stamp };
  if (invalidRemote.deleted_at === true) invalidRemote.deleted_at = stamp;
  const receipt = await hub.post('/v1/rows/push', { table: 'items', columns: Object.keys(invalidRemote), rows: [invalidRemote] });
  expect((receipt.data as { rejected: core.Row[] }).rejected.some(r => r.rule === rule.id)).toBe(true);
  expect(remote.db.query("SELECT * FROM items WHERE id='edited'").get()).toEqual(before[0]);
  const written = await core.writeRow(db, 'items', { id: 'edited', ...rule.allowed });
  expect(await core.writeability(db, { table: 'items' })).toEqual({ writable: true, reason: null });
  expect((await core.sync(db, hub)).rejected).toEqual([]);
  expect(remote.db.query("SELECT name,qty FROM items WHERE id='edited'").get()).toEqual({ name: written.name, qty: written.qty });
  const other = new TestSql(); databases.push(other.db);
  await core.sync(other, hub);
  const [received] = await other.all("SELECT * FROM items WHERE id='edited'");
  expect(received).toMatchObject({ ...written, hub_at: expect.any(String) });
  expect(await other.all('SELECT id,col,old,new FROM history ORDER BY id')).toEqual(await db.all('SELECT id,col,old,new FROM history ORDER BY id'));
  expect(await db.all("SELECT name FROM temp.sqlite_master WHERE name LIKE '_core_write_%'")).toEqual([]);
});

test('unbound external data and old cursors never certify full coverage', async () => {
  const { db, remote, hub, requests } = fixture();
  for (const row of remote.db.query('SELECT ddl FROM _schema_log ORDER BY id').all() as {ddl:string}[]) await db.run(row.ddl);
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text')");
  await db.run("INSERT INTO catalog_rules(id,tbl,kind,enforce,sql) VALUES ('r','items','invariant',1,'SELECT id FROM changed WHERE 0')");
  await blocked(db, 'coverage', { name: 'New' });
  await db.run("INSERT OR REPLACE INTO _core_state VALUES ('hub',?)", [hub.endpoint]);
  await db.run("INSERT OR REPLACE INTO _sync_state VALUES ('hub_url',?)", [hub.endpoint]);
  await db.run('INSERT INTO _core_sync(tbl,pull,push) VALUES (?,?,?)', ['items',T2,T2]);
  await blocked(db, 'coverage', { name: 'New' });
  await core.sync(db, hub);
  expect(requests.find(r => r.route === '/v1/rows/pull' && r.body.table === 'items')!.body.since).toBe('');
  expect((await db.all('SELECT id FROM items ORDER BY id')).map(r => r.id)).toEqual(['edited','untouched']);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test('skipping even history invalidates prior proof; re-enabling requires full backfill', async () => {
  const { db, hub, requests } = fixture();
  await core.sync(db, hub);
  await core.sync(db, hub, { tables: { history: false } });
  await blocked(db, 'coverage');
  expect((await core.writeability(db, { table: 'items' })).reason?.message).toContain('history');
  requests.length = 0;
  await core.sync(db, hub, { tables: { history: true } });
  expect(requests.find(r => r.route === '/v1/rows/pull' && r.body.table === 'history')!.body.since).toBe('');
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test('a failed refresh blocks writes until successful recovery, without trusting partial pages', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  const broken = { ...hub, async post(route: string, body: core.Row) {
    if (route === '/v1/rows/pull' && body.table === 'items') {
      await blocked(db, 'coverage');
      throw new Error('offline');
    }
    return hub.post(route, body);
  } };
  await expect(core.sync(db, broken)).rejects.toThrow('offline');
  await blocked(db, 'coverage');
  await core.sync(db, hub);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test('schema changes and downgraded cursor updates invalidate certificates', async () => {
  const { db, hub, requests } = fixture();
  await core.sync(db, hub);
  await db.run('ALTER TABLE items ADD COLUMN extra TEXT');
  await blocked(db, 'coverage');
  // Model a legacy client moving its cursor independently of coverage metadata.
  await db.run('UPDATE _core_sync SET pull=? WHERE tbl=?', [T2,'items']);
  await blocked(db, 'coverage');
  // Restore the physical schema; the cursor mismatch alone must still block.
  await db.run('ALTER TABLE items DROP COLUMN extra');
  await blocked(db, 'coverage');
  requests.length = 0;
  await core.sync(db, hub);
  expect(requests.find(r => r.route === '/v1/rows/pull' && r.body.table === 'items')!.body.since).toBe('');
});

for (const enabled of [0,1]) test(`FK cascade effects fail closed even with foreign_keys=${enabled}`, async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  await db.run('CREATE TABLE children(id TEXT PRIMARY KEY, parent TEXT REFERENCES items(id) ON UPDATE CASCADE)');
  await db.run(`PRAGMA foreign_keys=${enabled}`);
  await blocked(db, 'foreign_key');
});

test('estate and custom-trigger reasons match the actual writer', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  await db.run('ALTER TABLE catalog_rules ADD COLUMN scope TEXT');
  await db.run("UPDATE catalog_rules SET scope='estate'");
  await blocked(db, 'invariant');
  await db.run("UPDATE catalog_rules SET scope='table'");
  await db.run('CREATE TRIGGER custom AFTER UPDATE ON items BEGIN UPDATE limits SET qty=100; END');
  await blocked(db, 'trigger');
});

test.each([
  ['main', 'ON DELETE CASCADE'], ['main', 'ON UPDATE SET NULL'],
  ['main', 'ON DELETE SET DEFAULT'], ['temp', 'ON DELETE CASCADE'],
])('foreign-key action guards cover %s %s', async (database, action) => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  await db.run(`CREATE TABLE ${database}.children(id TEXT PRIMARY KEY,parent TEXT REFERENCES items(id) ${action})`);
  await blocked(db, 'foreign_key');
});

test.each(['NO ACTION', 'RESTRICT'])('unenforced DDL foreign keys with %s cannot masquerade as catalog reference validation', async action => {
  const db = new TestSql(); databases.push(db.db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('PRAGMA foreign_keys=OFF');
  await db.run(`CREATE TABLE children(id TEXT PRIMARY KEY,name TEXT REFERENCES items(id) ON UPDATE ${action},created_at TEXT,updated_at TEXT,deleted_at TEXT)`);
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('children.name','children','name','text')");
  await expect(core.writeRow(db, 'children', { name: 'missing-parent' })).rejects.toBeInstanceOf(core.ValidationError);
  expect((await core.writeability(db, { table: 'children' })).reason?.rule).toBe('foreign_key');
  expect(await db.all('SELECT * FROM children')).toEqual([]);
});

test('schema-level REPLACE cannot silently remove another row', async () => {
  const db = new TestSql(); databases.push(db.db);
  for (const ddl of schema) await db.run(ddl.replace('name TEXT, qty', 'name TEXT UNIQUE ON CONFLICT REPLACE, qty'));
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text')");
  await core.writeRow(db, 'items', { name: 'same' }, { id: () => 'first' });
  await expect(core.writeRow(db, 'items', { name: 'same' }, { id: () => 'second' })).rejects.toBeInstanceOf(core.ValidationError);
  expect((await db.all('SELECT id FROM items')).map(r => r.id)).toEqual(['first']);
  await core.writeRow(db, 'items', { name: 'other' }, { id: () => 'second' });
  await expect(core.writeRow(db, 'items', { id: 'second', name: 'same' })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await db.all('SELECT id,name FROM items ORDER BY id')).toEqual([{ id: 'first', name: 'same' }, { id: 'second', name: 'other' }]);
});

test('complete and interrupted coverage both survive closing and reopening the database', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'core-coverage-'));
  const { db, hub } = fixture();
  const path = join(temp, 'replica.db');
  db.db.close(); db.db = new Database(path);
  try {
    await core.sync(db, hub);
    db.db.close(); db.db = new Database(path);
    expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
    await expect(core.sync(db, { ...hub, async post(route, body) {
      if (route === '/v1/rows/pull') throw new Error('offline');
      return hub.post(route, body);
    } })).rejects.toThrow('offline');
    db.db.close(); db.db = new Database(path);
    await blocked(db, 'coverage');
    await core.sync(db, hub);
    expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  } finally { db.db.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('failure on the second full-pull page cannot leave a certificate or lose older missing rows', async () => {
  const { db, remote, hub, requests } = fixture();
  for (let i=0;i<205;i++) remote.db.query('INSERT INTO items(id,name,qty,updated_at,hub_at) VALUES (?,?,?,?,?)').run(String(i).padStart(3,'0'),'Page',2,T0,T1);
  await expect(core.sync(db, { ...hub, async post(route, body) {
    if (route === '/v1/rows/pull' && body.table === 'items' && body.after) throw new Error('second page failed');
    return hub.post(route, body);
  } })).rejects.toThrow('second page');
  await blocked(db, 'coverage', { name: 'New' });
  requests.length = 0;
  await core.sync(db, hub);
  expect(requests.find(r => r.route === '/v1/rows/pull' && r.body.table === 'items')!.body.since).toBe('');
  expect((await db.all('SELECT count(*) AS n FROM items'))[0].n).toBe(207);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test.each([
  "UPDATE _core_coverage SET version=0 WHERE tbl='items'",
  "UPDATE _core_coverage SET endpoint='https://other.test' WHERE tbl='items'",
  "DELETE FROM _core_coverage WHERE tbl='limits'",
  "UPDATE _sync_state SET value='https://other.test' WHERE key='hub_url'",
])('missing, downgraded or differently bound proof fails closed: %s', async sql => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  await db.run(sql);
  await blocked(db, 'coverage');
});

test('coverage readiness and cursors commit atomically; a failed certification keeps writes blocked', async () => {
  const { db, hub } = fixture();
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    if (sql.startsWith('INSERT OR REPLACE INTO _core_coverage')) throw new Error('disk full');
    return run(sql, params);
  };
  await expect(core.sync(db, hub)).rejects.toThrow('disk full');
  db.run = run;
  expect(await db.all('SELECT * FROM _core_sync')).toEqual([]);
  expect(await db.all('SELECT * FROM _core_coverage')).toEqual([]);
  await blocked(db, 'coverage');
  await core.sync(db, hub);
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
});

test('metadata-only search initialization preserves coverage, while mid-sync public schema changes do not', async () => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  await core.search(db, { text: 'Initial' });
  expect((await core.writeability(db, { table: 'items' })).writable).toBe(true);
  let changed = false;
  await expect(core.sync(db, { ...hub, async post(route, body) {
    if (!changed && route === '/v1/rows/pull') { changed = true; await db.run('ALTER TABLE items ADD COLUMN unexpected TEXT'); }
    return hub.post(route, body);
  } })).rejects.toThrow('schema changed');
  await blocked(db, 'coverage');
});

test('advisory is read-only, handles missing schemas, and never promises patch validity', async () => {
  const db = new TestSql(); databases.push(db.db);
  const before = await db.all('SELECT * FROM sqlite_master');
  expect((await core.writeability(db, { table: 'items' })).reason?.rule).toBe('schema');
  expect(await db.all('SELECT * FROM sqlite_master')).toEqual(before);
  expect((await core.writeability(db, { table: '_core_state' })).reason?.rule).toBe('read_only');
  const synced = fixture(); await core.sync(synced.db, synced.hub);
  expect((await core.writeability(synced.db, { table: 'items' })).writable).toBe(true);
  await expect(core.writeRow(synced.db, 'items', { id: 'edited', qty: 'not a number' })).rejects.toBeInstanceOf(core.ValidationError);
});

test('a complete replica is not a current remote snapshot; hub revalidation retains a rejected edit', async () => {
  const { db, remote, hub } = fixture(rules.find(r => r.id === 'cross-table')!);
  await core.sync(db, hub);
  await core.writeRow(db, 'items', { id: 'edited', qty: 4 });
  const limit = remote.db.query("SELECT * FROM limits WHERE id='cap'").get() as core.Row;
  const updated = { ...limit, qty: 3, updated_at: new Date().toISOString() };
  const receipt = await hub.post('/v1/rows/push', { table: 'limits', columns: Object.keys(updated), rows: [updated] });
  expect((receipt.data as {rejected: unknown[]}).rejected).toEqual([]);
  const result = await core.sync(db, hub);
  expect(result.rejected).toContainEqual(expect.objectContaining({ table: 'items', id: 'edited', rule: 'cross-table' }));
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(await db.all("SELECT col,old,new FROM history WHERE tbl='items'")).toEqual([{ col: 'qty', old: '2', new: '4' }]);
  expect(remote.db.query("SELECT qty FROM items WHERE id='edited'").get()).toEqual({ qty: 2 });
  expect(remote.db.query("SELECT * FROM history WHERE tbl='items'").all()).toEqual([]);
});

test('unsupported host FK introspection fails closed with the same advisory reason', async () => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  const all = db.all.bind(db);
  db.all = async (sql, params) => {
    if (sql.includes('foreign_key_list')) throw new Error('not authorized');
    return all(sql, params);
  };
  await blocked(db, 'storage');
  db.all = all;
});

test('insert contexts have empty before; rule or history failure rolls back all state', async () => {
  const { db, hub } = fixture(rules.find(r => r.id === 'context-shape')!);
  await core.sync(db, hub);
  expect((await core.writeRow(db, 'items', { name: 'Created', qty: 2 })).name).toBe('Created');
  const before = await db.all('SELECT * FROM items ORDER BY id');
  const pending = await core.syncStatus(db);
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    if (sql.includes('INTO main.history')) throw new Error('disk failure');
    return run(sql, params);
  };
  await expect(core.writeRow(db, 'items', { id: 'edited', name: 'Changed' })).rejects.toBeInstanceOf(core.ValidationError);
  db.run = run;
  expect(await db.all('SELECT * FROM items ORDER BY id')).toEqual(before);
  expect(await core.syncStatus(db)).toEqual(pending);
  expect(await db.all("SELECT * FROM temp.sqlite_master WHERE name LIKE '_core_write_%'")).toEqual([]);
});

test('now.ts is captured once, independently of a monotonic revision advanced beyond that instant', async () => {
  const { db, hub } = fixture(); await core.sync(db, hub);
  await db.run('UPDATE items SET updated_at=? WHERE id=?', [T1,'edited']);
  await db.run('UPDATE catalog_rules SET sql=?', [`SELECT id FROM changed WHERE (SELECT ts FROM now) IS NOT '${T1}'`]);
  let calls = 0;
  const row = await core.writeRow(db, 'items', { id: 'edited', qty: 3 }, { now: () => { calls++; return new Date(T1); } });
  expect(calls).toBe(1);
  expect(row.updated_at).toBe('2026-01-02T00:00:00.001Z');
});

test.each([null, {}, { table: 7 }, { table: 'items', extra: true }])('malformed advisory arguments produce a serializable reason: %j', async args => {
  const db = new TestSql(); databases.push(db.db);
  const result = await core.writeability(db, args as core.WriteabilityArgs);
  expect(result.writable).toBe(false);
  expect(result.reason?.rule).toBe('input');
  expect(typeof result.reason?.tbl).toBe('string');
});

test('advisory does not invoke caller getters', async () => {
  const db = new TestSql(); databases.push(db.db);
  let invoked = false;
  const result = await core.writeability(db, { get table() { invoked = true; return 'items'; } });
  expect(invoked).toBe(false);
  expect(result.reason?.rule).toBe('input');
});

test.each([
  { sql: 'DELETE FROM items' }, { sql: 'SELECT random()' }, { sql: "SELECT datetime('now')" },
  { sql: 'SELECT missing FROM changed' }, { enforce: 2 },
])('unsupported rules fail closed before mutation: %j', async change => {
  const { db, hub } = fixture();
  await core.sync(db, hub);
  for (const [key,value] of Object.entries(change)) await db.run(`UPDATE catalog_rules SET ${key}=?`, [value]);
  await blocked(db, 'invariant');
});
