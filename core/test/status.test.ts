import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import type { Hub } from '../src/driver.ts';
import { schema, setup, TestSql, T0, T1 } from './support.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function replica(path?: string) {
  const fixture = setup();
  if (path) { fixture.db.db.close(); fixture.db.db = new Database(path); }
  cleanup.push(() => fixture.db.db.close(), () => fixture.remote.db.close());
  for (const [col, type, required] of [['name', 'text', 1], ['qty', 'int', 0]]) {
    fixture.remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)')
      .run(`items.${col}`, 'items', col, type, required, T0, T1);
  }
  await core.sync(fixture.db, fixture.hub);
  return fixture;
}

test('syncStatus is exported and an empty replica has no UI work or successful sync', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  expect(typeof core.syncStatus).toBe('function');
  expect(await core.syncStatus(db)).toEqual({ lastSuccessfulSync: null, pendingUiEdits: 0, rejected: 0, skippedTables: [] });
});

test('status and coalesced UI markers persist across reopening the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-pending-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db } = await replica(path);
  const baseline = await core.syncStatus(db);
  const row = await core.writeRow(db, 'items', { name: 'Before' });
  const edited = await core.writeRow(db, 'items', { id: row.id, name: 'After' });
  // Other local writers have no UI marker. Their entire queue is not our count.
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)', ['cli', 'CLI edit', T1]);
  await db.run('INSERT INTO _core_rejected(tbl,row_id,row,errors) VALUES (?,?,?,?)', ['items', 'cli', '{}', '[{},{}]']);
  db.db.close(); db.db = new Database(path);
  expect(await core.syncStatus(db)).toEqual({ ...baseline, pendingUiEdits: 1, rejected: 1 });
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: row.id, updated_at: edited.updated_at }]);
});

test.each(['offline', 'lost receipt', 'malformed receipt', 'rejection'])('pending UI edits survive %s until an accepted retry', async failure => {
  const { db, hub, remote } = await replica();
  const before = await core.syncStatus(db);
  const row = await core.writeRow(db, 'items', { name: 'Offline edit' }, { id: () => 'a' });
  if (failure === 'rejection') {
    remote.db.query("UPDATE catalog_properties SET required=1,updated_at=?,hub_at=? WHERE col='qty'").run(T1, new Date().toISOString());
  }
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items') {
      if (failure === 'offline') throw new Error('offline');
      if (failure === 'lost receipt') { await hub.post(route, body); throw new Error('offline'); }
      if (failure === 'malformed receipt') return { data: { upserted: 0, rejected: [] } };
    }
    return hub.post(route, body);
  } };
  const attempt = core.sync(db, transport, { now: () => new Date(Date.now() + 50) });
  if (failure === 'rejection') expect((await attempt).rejected).toMatchObject([{ id: 'a', table: 'items', rule: 'required' }]);
  else await expect(attempt).rejects.toThrow(failure === 'malformed receipt' ? 'invalid push response' : 'offline');
  expect(await core.syncStatus(db)).toEqual({ ...before, pendingUiEdits: 1, rejected: failure === 'rejection' ? 1 : 0 });
  if (failure === 'rejection') await core.writeRow(db, 'items', { id: row.id, qty: 1 });
  const finished = new Date(Date.now() + 100);
  await core.sync(db, hub, { now: () => finished });
  expect(await core.syncStatus(db)).toEqual({ lastSuccessfulSync: finished.toISOString(), pendingUiEdits: 0, rejected: 0, skippedTables: [] });
  expect(remote.db.query('SELECT name FROM items WHERE id=?').get(row.id)).toEqual({ name: 'Offline edit' });
});

test('an accepted push preserves a newer concurrent UI edit of the same row', async () => {
  const { db, hub, remote } = await replica();
  const row = await core.writeRow(db, 'items', { name: 'First' }, { id: () => 'a' });
  let newer = row;
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items') {
      newer = await core.writeRow(db, 'items', { id: row.id, name: 'Second' });
    }
    return hub.post(route, body);
  } };
  await core.sync(db, transport);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: row.id, updated_at: newer.updated_at }]);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'First' });
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'Second' });
});

test('other clients acknowledgments and downloaded rows never imply a UI receipt', async () => {
  const { db, hub } = await replica();
  const row = await core.writeRow(db, 'items', { name: 'Shared replica' });
  // Same HTTP operation the Python daemon performs, without core sync handling its receipt.
  await hub.post('/v1/rows/push', { table: 'items', columns: Object.keys(row), rows: [row] });
  await db.run("INSERT OR REPLACE INTO _sync_state(key,value) VALUES ('last_push',?),('last_pull',?)", [row.updated_at as string, row.updated_at as string]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  const other = new TestSql(); cleanup.push(() => other.db.close());
  await core.sync(other, hub);
  expect((await core.syncStatus(other)).pendingUiEdits).toBe(0);
  expect(await other.all('SELECT name FROM items')).toEqual([{ name: 'Shared replica' }]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('an accepted newer non-UI revision resolves an older UI marker for the same row', async () => {
  const { db, hub, remote } = await replica();
  const row = await core.writeRow(db, 'items', { name: 'UI edit' });
  const newer = new Date(Date.parse(String(row.updated_at)) + 1).toISOString();
  await db.run('UPDATE items SET name=?,updated_at=? WHERE id=?', ['CLI edit', newer, String(row.id)]);
  expect(await db.all('SELECT updated_at FROM _core_pending')).toEqual([{ updated_at: row.updated_at }]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'CLI edit' });
});

test('skipped tables keep UI markers until an explicit backfill accepts them', async () => {
  const { db, hub, remote } = await replica();
  await core.writeRow(db, 'items', { name: 'Skipped' });
  await core.sync(db, hub, { tables: { items: false } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(remote.db.query('SELECT * FROM items').all()).toEqual([]);
  await core.sync(db, hub, { tables: { items: true } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('accepted batches clear only their UI markers even if a later batch fails', async () => {
  const { db, hub } = await replica();
  const before = await core.syncStatus(db);
  for (let i = 0; i < 201; i++) await core.writeRow(db, 'items', { name: 'Pending' }, { id: () => String(i).padStart(3, '0') });
  let batches = 0;
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items' && ++batches === 2) throw new Error('offline');
    return hub.post(route, body);
  } };
  await expect(core.sync(db, transport)).rejects.toThrow('offline');
  expect(await core.syncStatus(db)).toEqual({ ...before, pendingUiEdits: 1 });
  expect(await db.all('SELECT row_id FROM _core_pending')).toEqual([{ row_id: '200' }]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('a pending UI revision below the checkpoint still sends its state and original history', async () => {
  const { db, hub, remote } = await replica();
  remote.db.query('INSERT INTO items(id,name,created_at,updated_at,hub_at) VALUES (?,?,?,?,?)').run('a', 'Before', T0, T0, T1);
  await core.sync(db, hub);
  await core.writeRow(db, 'items', { id: 'a', name: 'After' }, { now: () => new Date(T1) });
  const originals = await db.all('SELECT id,col,old,new FROM history');
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'After' });
  expect(remote.db.query('SELECT id,col,old,new FROM history').all()).toEqual(originals);
});

test('acknowledging one table never clears another table marker with the same row id', async () => {
  const { db, hub, remote } = await replica();
  const ddl = schema[0]!.replace('CREATE TABLE items', 'CREATE TABLE peers');
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)')
    .run('peers.name', 'peers', 'name', 'text', T0, new Date().toISOString());
  await core.sync(db, hub, { tables: { peers: true } });
  const stamp = new Date();
  await core.writeRow(db, 'items', { name: 'First table' }, { id: () => 'same', now: () => stamp });
  const other = await core.writeRow(db, 'peers', { name: 'Second table' }, { id: () => 'same', now: () => stamp });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(2);
  await core.sync(db, hub, { tables: { peers: false } });
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'peers', row_id: 'same', updated_at: other.updated_at }]);
  await core.sync(db, hub, { tables: { peers: true } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('last completed round skipped tables survive reopening and clear after a complete backfill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-skips-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db, hub } = await replica(path);
  const result = await core.sync(db, hub, { tables: { items: false, history: false } });
  expect(result.skipped).toEqual(['history', 'items']);
  const before = await core.syncStatus(db);
  expect(before.skippedTables).toEqual(['history', 'items']);
  expect(await db.all("SELECT value FROM _core_state WHERE key='skipped_tables'")).toEqual([{ value: '["history","items"]' }]);
  db.db.close(); db.db = new Database(path);
  expect(await core.syncStatus(db)).toEqual(before);
  await core.sync(db, hub, { tables: { items: true, history: true } });
  expect((await core.syncStatus(db)).skippedTables).toEqual([]);
});

test.each(['schema', 'rows', 'commit'])('failed next %s round retains previous skips and time', async failure => {
  const { db, hub, remote } = await replica();
  await core.sync(db, hub, { tables: { history: false } });
  const before = await core.syncStatus(db);
  const transport: Hub = { ...hub, async post(route, body) {
    if (failure === 'schema' && route === '/v1/schema/pull') throw new Error('schema offline');
    if (failure === 'rows' && route === '/v1/rows/pull' && body.table === 'items') throw new Error('rows offline');
    return hub.post(route, body);
  } };
  const transaction = db.transaction.bind(db);
  if (failure === 'commit') db.transaction = body => transaction(async () => {
    const result = await body();
    const current = await db.all("SELECT value FROM _core_state WHERE key='coverage_phase'");
    if (current[0]?.value === 'ready') throw new Error('commit failed');
    return result;
  });
  const attempt = core.sync(db, transport);
  await expect(attempt).rejects.toThrow();
  const after = await core.syncStatus(db);
  expect(after.lastSuccessfulSync).toBe(before.lastSuccessfulSync);
  expect(after.skippedTables).toEqual(['history']);
});

test('legacy web skipped_tables state is read without host certification or mutation', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  await core.initCore(db);
  await db.run("INSERT INTO _core_state(key,value) VALUES ('last_sync',?),('skipped_tables',?)", [T0, '["items"]']);
  const before = await db.all('SELECT * FROM _core_state ORDER BY key');
  expect(await core.syncStatus(db)).toEqual({ lastSuccessfulSync: T0, pendingUiEdits: 0, rejected: 0, skippedTables: ['items'] });
  expect(await db.all('SELECT * FROM _core_state ORDER BY key')).toEqual(before);
  expect(await db.all('SELECT * FROM _core_coverage')).toEqual([]);
});

test.each(['{bad', '{}', 'null', '[1]', '[""]', '["items","items"]'])('malformed skipped status is explicit, never silently complete: %s', async value => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  await core.initCore(db);
  await db.run("INSERT INTO _core_state(key,value) VALUES ('skipped_tables',?)", [value]);
  await expect(core.syncStatus(db)).rejects.toThrow('Invalid saved skipped-table status');
});

test.each([false, true])('completed pulls publish changed skips despite a rejected push; prior success=%s', async previousSuccess => {
  const fixture = setup();
  const { db, remote, hub } = fixture;
  cleanup.push(() => db.db.close(), () => remote.db.close());
  for (const ddl of schema) await db.run(ddl);
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type,required) VALUES ('items.name','items','name','text',1),('items.qty','items','qty','int',0)");
  // The hub already requires qty; a skipped initial pull must not make the UI
  // marker disappear. The next round receives this rule and rejects the edit.
  for (const [col, type] of [['name','text'],['qty','int']]) {
    remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run(`items.${col}`,'items',col,type,1,T0,T1);
  }
  if (previousSuccess) await core.sync(db, hub, { tables: { items: false } });
  await db.run("UPDATE catalog_properties SET required=0 WHERE col='qty'");
  await core.writeRow(db, 'items', { name: 'Missing qty' });
  const before = await core.syncStatus(db);
  const result = await core.sync(db, hub, { tables: { history: false } });
  expect(result.rejected.length).toBeGreaterThan(0);
  expect(result.skipped).toEqual(['history']);
  const after = await core.syncStatus(db);
  expect(after.lastSuccessfulSync).toBe(before.lastSuccessfulSync);
  expect(after.skippedTables).toEqual(['history']);
  expect(await db.all("SELECT value FROM _core_state WHERE key='skipped_tables'")).toEqual([{ value: '["history"]' }]);
});
