import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import { setup, TestSql, T0, T1 } from './support.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function handlers(db: TestSql) {
  return core.createCoreHandlers(db, () => { throw Error('Inbox reads must not contact the hub'); });
}
async function inbox() {
  const db = new TestSql();
  cleanup.push(() => db.db.close());
  await core.initCore(db);
  return db;
}
async function put(db: TestSql, id: string, table = 'items') {
  const submitted = { id, name: 'Submitted', qty: null, updated_at: T1, deleted_at: null };
  const errors = [{ id, error: 'future-reason', detail: { allowed: false, values: [null, 3, 'text'] } }];
  await db.run('INSERT INTO _core_rejected(tbl,row_id,row,errors) VALUES (?,?,?,?)',
    [table, id, JSON.stringify(submitted), JSON.stringify(errors)]);
  return { table, rowID: id, submitted, errors };
}

test('rejections is a shared operation and an unopened inbox reads empty without writes', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  const before = await db.all('SELECT * FROM sqlite_master');
  const api = handlers(db);
  expect(typeof api.rejections).toBe('function');
  expect(await api.rejections({})).toEqual({ rejections: [], nextOffset: null });
  expect(await db.all('SELECT * FROM sqlite_master')).toEqual(before);
});

test('real hub rejection survives reopen and local repair until an accepted sync receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-rejections-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db, remote, hub } = setup();
  db.db.close(); db.db = new Database(path);
  cleanup.push(() => db.db.close(), () => remote.db.close());
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)')
    .run('items.name', 'items', 'name', 'text', 1, T0, T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)')
    .run('items.qty', 'items', 'qty', 'int', 0, T0, T1);
  await core.sync(db, hub);
  const submitted = await core.writeRow(db, 'items', { name: 'Needs correction' }, { id: () => 'e\u0301' });
  remote.db.query("UPDATE catalog_properties SET required=1,updated_at=?,hub_at=? WHERE col='qty'")
    .run(T1, new Date().toISOString());
  const result = await core.sync(db, hub);
  expect(result.rejected.length).toBeGreaterThan(0);
  db.db.close(); db.db = new Database(path);
  const api = handlers(db);
  const page = await api.rejections({});
  expect(page.nextOffset).toBeNull();
  expect(page.rejections).toHaveLength(1);
  expect(page.rejections[0]).toEqual({
    table: 'items', rowID: 'e\u0301', submitted,
    errors: result.rejected.map(({ table, ...error }) => error),
  });
  await expect(core.sync(db, { ...hub, post: async () => { throw Error('offline'); } })).rejects.toThrow('offline');
  expect(await api.rejections({})).toEqual(page);
  const repaired = await core.writeRow(db, 'items', { id: submitted.id, qty: 2 }, { expectedUpdatedAt: String(submitted.updated_at) });
  expect(await api.rejections({})).toEqual(page);
  expect((await core.syncStatus(db)).rejected).toBe(1);
  await core.sync(db, hub);
  expect(await api.rejections({})).toEqual({ rejections: [], nextOffset: null });
  expect(remote.db.query('SELECT id,qty FROM items').get()).toEqual({ id: repaired.id, qty: 2 });
});

test('bounded pages have exact terminal detection and preserve table/byte identities and unknown fields', async () => {
  const db = await inbox();
  // Deliberately reverse insertion order: page order belongs to SQLite BINARY.
  for (let i = 204; i >= 0; i--) await put(db, String(i).padStart(3, '0'));
  const api = handlers(db);
  const first = await api.rejections({});
  expect(first.rejections).toHaveLength(100);
  expect(first.rejections[0]?.rowID).toBe('000');
  expect(first.rejections.at(-1)?.rowID).toBe('099');
  expect(first.nextOffset).toBe(100);
  const second = await api.rejections({ offset: 100 });
  expect(second.rejections[0]?.rowID).toBe('100');
  expect(second.rejections.at(-1)?.rowID).toBe('199');
  expect(second.nextOffset).toBe(200);
  const last = await api.rejections({ limit: 5, offset: 200 });
  expect(last.rejections.map(row => row.rowID)).toEqual(['200', '201', '202', '203', '204']);
  expect(last.nextOffset).toBeNull();
  expect((await api.rejections({ limit: 200 })).rejections).toHaveLength(200);
  expect(await api.rejections({ offset: 205 })).toEqual({ rejections: [], nextOffset: null });

  await db.run('DELETE FROM _core_rejected');
  const composed = await put(db, '\u00e9', 'z_removed');
  const decomposed = await put(db, 'e\u0301', 'z_removed');
  const spaced = await put(db, ' id \u0000', 'z_removed');
  const otherTable = await put(db, '\u00e9', 'A_removed');
  const before = await db.all('SELECT * FROM _core_rejected ORDER BY tbl,row_id');
  expect(await api.rejections({})).toEqual({ rejections: [otherTable, spaced, decomposed, composed], nextOffset: null });
  expect(await db.all('SELECT * FROM _core_rejected ORDER BY tbl,row_id')).toEqual(before);
});

test('only the requested page and one lookahead leave SQLite, using the read-only driver seam', async () => {
  const db = await inbox();
  for (let i = 0; i < 10; i++) await put(db, String(i));
  const all = db.all.bind(db);
  let largestRead = 0;
  db.all = async (...input) => {
    const rows = await all(...input);
    largestRead = Math.max(largestRead, rows.length);
    return rows;
  };
  db.run = async () => { throw Error('Read issued a write'); };
  db.transaction = async () => { throw Error('Read reserved a writer transaction'); };
  expect(await core.readRejections(db, { limit: 1, offset: 3 })).toMatchObject({
    rejections: [{ rowID: '3' }], nextOffset: 4,
  });
  expect(largestRead).toBe(2);
});

test('all raw rejection objects and optional submitted fields survive the JSON bridge', async () => {
  const db = await inbox();
  const expected = await put(db, 'x');
  const errors = [{ id: 'x', col: 'qty', message: 'Required' }, { id: 'x', rule: 'future', context: [null, { active: true }] }];
  await db.run('UPDATE _core_rejected SET errors=?', [JSON.stringify(errors)]);
  expect(JSON.parse(JSON.stringify(await handlers(db).rejections({})))).toEqual({
    rejections: [{ ...expected, errors }], nextOffset: null,
  });
});

test.each([
  null, [], 'bad', { table: 'items' }, { limit: null }, { limit: 0 }, { limit: -1 },
  { limit: 201 }, { limit: 1.5 }, { limit: '1' }, { limit: Infinity },
  { offset: null }, { offset: -1 }, { offset: 0.5 }, { offset: '0' },
  { offset: Number.MAX_SAFE_INTEGER },
])('invalid pagination fails before any database access: %j', async args => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  let reads = 0;
  const all = db.all.bind(db);
  db.all = async (...input) => { reads++; return all(...input); };
  await expect(handlers(db).rejections(args as never)).rejects.toThrow(/argument|pagination/i);
  expect(reads).toBe(0);
  expect(await all('SELECT * FROM sqlite_master')).toEqual([]);
});

test.each([
  ['row', '{secret-invalid-json'], ['row', 'null'], ['row', '[]'], ['row', '{"id":7}'],
  ['row', '{}'], ['row', '{"id":"other"}'], ['row', '{"id":"x","number":1e400}'],
  ['errors', '{secret-invalid-json'], ['errors', '{}'], ['errors', 'null'], ['errors', '[]'],
  ['errors', '[null]'], ['errors', '["secret-error"]'], ['errors', '[{}]'],
  ['errors', '[{"id":"other"}]'], ['errors', '[{"id":"x","detail":{"n":1e400}}]'],
  ['tbl', null], ['tbl', ''], ['row_id', null], ['row_id', ''],
])('malformed persisted %s throws a payload-free error and never cleans or rewrites the inbox', async (column, value) => {
  const db = await inbox();
  await put(db, 'x');
  await db.run(`UPDATE _core_rejected SET ${column}=?`, [value]);
  const before = await db.all('SELECT * FROM _core_rejected');
  const attempt = handlers(db).rejections({});
  await expect(attempt).rejects.toThrow(/invalid.*rejection/i);
  try { await attempt; } catch (error) { expect(String(error)).not.toContain('secret'); }
  expect(await db.all('SELECT * FROM _core_rejected')).toEqual(before);
});

test('corruption fails the entire fetched page and retries preserve the same entries', async () => {
  const db = await inbox();
  await put(db, 'a');
  await put(db, 'b');
  await put(db, 'c');
  await db.run("UPDATE _core_rejected SET errors='broken-private-payload' WHERE row_id='b'");
  const before = await db.all('SELECT * FROM _core_rejected ORDER BY row_id');
  for (const limit of [1, 3, 3]) {
    await expect(handlers(db).rejections({ limit })).rejects.toThrow(/invalid.*rejection/i);
    expect(await db.all('SELECT * FROM _core_rejected ORDER BY row_id')).toEqual(before);
  }
});

test('a canonically equivalent but byte-distinct submitted ID is corruption, not the same record', async () => {
  const db = await inbox();
  await put(db, '\u00e9');
  await db.run('UPDATE _core_rejected SET row=?', [JSON.stringify({ id: 'e\u0301' })]);
  await expect(handlers(db).rejections({})).rejects.toThrow(/invalid.*rejection/i);
});

test('matching empty identities still fail instead of authorizing repair of an invalid ID', async () => {
  const db = await inbox();
  await put(db, '');
  await expect(handlers(db).rejections({})).rejects.toThrow(/invalid.*rejection/i);
});

test('main inbox is authoritative even with a same-named temporary object', async () => {
  const db = await inbox();
  const expected = await put(db, 'main-id');
  await db.run('CREATE TEMP TABLE _core_rejected AS SELECT * FROM main._core_rejected WHERE 0');
  expect(await handlers(db).rejections({})).toEqual({ rejections: [expected], nextOffset: null });
});

test('an incompatible stored inbox is visible as an error, not an empty success', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  await db.run('CREATE VIEW _core_rejected AS SELECT 1 AS invalid');
  const before = await db.all('SELECT * FROM sqlite_master');
  await expect(handlers(db).rejections({})).rejects.toThrow(/invalid.*rejection/i);
  expect(await db.all('SELECT * FROM sqlite_master')).toEqual(before);
});
