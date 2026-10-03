import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import { setup, TestSql, T0, T1 } from './support.ts';
// @ts-ignore Exercise the production Worker through HTTP with synthetic data.
import worker from '../../worker/src/index.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(count = 205, collation = 'BINARY') {
  const { db, remote } = setup();
  cleanup.push(() => db.db.close(), () => remote.db.close());
  if (collation !== 'BINARY') {
    const original = remote.db.query("SELECT sql FROM sqlite_master WHERE name='items'").get().sql;
    const ddl = original.replace('PRIMARY KEY', `PRIMARY KEY COLLATE ${collation}`);
    remote.db.exec(`DROP TABLE items; ${ddl}`);
    remote.db.query('UPDATE _schema_log SET ddl=? WHERE ddl=?').run(ddl, original);
  }
  const ddl = 'CREATE TABLE catalog_tables(id TEXT PRIMARY KEY, display TEXT, kind TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)';
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query('INSERT INTO catalog_tables VALUES (?,?,?,?,?,?)').run('items', 'name', 'table', T0, null, T1);
  remote.db.query('INSERT INTO catalog_tables VALUES (?,?,?,?,?,?)').run('history', 'id', 'system', T0, null, T1);
  const insert = remote.db.query('INSERT INTO items VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < count; i++) insert.run(`row${String(i).padStart(3, '0')}`, `Item ${i}`, i, T0, T0, i === 3 ? T1 : null, T1);
  const requests: { path: string; authenticated: boolean; body: any }[] = [];
  const control: { reply?: (response: Response) => Promise<Response> } = {};
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, authenticated: request.headers.has('Authorization'), body: await request.clone().json() });
    const response = await worker.fetch(request, { DB: remote, HUB_TOKEN: 'fixture' }, { waitUntil() {} });
    return control.reply ? control.reply(response) : response;
  } });
  cleanup.push(() => server.stop(true));
  const hub = core.createHttpHub(server.url.toString(), 'fixture', fetch);
  await core.sync(db, hub, { tables: { items: false } });
  expect(await db.all('SELECT * FROM items')).toEqual([]);
  requests.length = 0;
  const before = db.db.serialize();
  // These operations may reserve a transaction for consistent metadata, but
  // must never execute writes, including initialization or TEMP staging.
  const readonly: core.SqlDriver = { all: db.all.bind(db), transaction: db.transaction.bind(db), async run() { throw new Error('remote browsing wrote local data'); } };
  return { db, readonly, remote, hub, requests, control, before };
}

test('real HTTP browsing reads 205 skipped rows one page per call without changing local state', async () => {
  const { db, readonly, hub, requests, before } = await fixture();
  const first = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 200 });
  expect(first.rows).toHaveLength(200);
  expect(first.rows[3]).toEqual({ record: { id: 'row003', name: 'Item 3', qty: 3, created_at: T0, updated_at: T0, deleted_at: T1, hub_at: T1 }, label: 'Item 3', deleted: true });
  expect(first.rows[0].deleted).toBe(false);
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.nextCursor).not.toBe('row199');
  expect(requests).toEqual([{ path: '/v1/rows/pull', authenticated: true, body: { table: 'items', since: '', columns: ['id', 'name', 'qty', 'created_at', 'updated_at', 'deleted_at', 'hub_at'], limit: 200 } }]);
  const last = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 200, cursor: first.nextCursor! });
  expect(last.rows.map(row => row.record.id)).toEqual(['row200', 'row201', 'row202', 'row203', 'row204']);
  expect(last.nextCursor).toBeNull();
  expect(requests).toHaveLength(2);
  expect(requests[1].body.after).toBe('row199');
  expect(db.db.serialize()).toEqual(before);
});

test('default 50-row pages retain the required empty terminal request for an exact full page', async () => {
  const { readonly, hub, requests } = await fixture(50);
  const first = await core.readRemoteRows(readonly, hub, { table: 'items' });
  expect(first.rows).toHaveLength(50);
  expect(requests).toHaveLength(1);
  const last = await core.readRemoteRows(readonly, hub, { table: 'items', cursor: first.nextCursor! });
  expect(last).toEqual({ rows: [], nextCursor: null });
  expect(requests).toHaveLength(2);
});

test.each([['NOCASE', 'Example', 'eXAMPLE'], ['RTRIM', 'Example', 'Example  '], ['BINARY', "quoted'ID", "quoted'ID"]])('ID lookup uses SQLite %s equality and returns the stored identity', async (collation, stored, lookup) => {
  const { db, readonly, remote, hub, requests, before } = await fixture(0, collation);
  remote.db.query('INSERT INTO items(id,name,updated_at,deleted_at) VALUES (?,?,?,?)').run(stored, '  Display  ', T0, T1);
  const found = await core.readRemoteRow(readonly, hub, { table: 'items', id: lookup });
  expect(found.row).toMatchObject({ record: { id: stored, qty: null }, label: 'Display', deleted: true });
  expect(requests[0].body).toMatchObject({ where: { id: lookup }, limit: 2, since: '' });
  expect((await core.readRemoteRow(readonly, hub, { table: 'items', id: 'absent' })).row).toBeNull();
  expect(requests).toHaveLength(2);
  expect(db.db.serialize()).toEqual(before);
});

test('NOCASE paging follows the source collation instead of JavaScript lexical order', async () => {
  const { readonly, remote, hub } = await fixture(0, 'NOCASE');
  for (const id of ['Z', 'a', 'B']) remote.db.query('INSERT INTO items(id,updated_at) VALUES (?,?)').run(id, T0);
  const first = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 2 });
  expect(first.rows.map(row => row.record.id)).toEqual(['a', 'B']);
  const last = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 2, cursor: first.nextCursor! });
  expect(last.rows.map(row => row.record.id)).toEqual(['Z']);
});

test('receipt comparison ignores retained local rows and does not stage remote IDs', async () => {
  const { db, readonly, hub } = await fixture(2, 'NOCASE');
  db.db.query('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)').run('retained', 'Local only', T0);
  const before = db.db.serialize();
  expect((await core.readRemoteRows(readonly, hub, { table: 'items', limit: 1 })).rows[0].record.id).toBe('row000');
  expect((await core.readRemoteRow(readonly, hub, { table: 'items', id: 'ROW001' })).row?.record.id).toBe('row001');
  expect(db.db.serialize()).toEqual(before);
});

test('NOCASE-equivalent duplicate IDs in a malformed response fail before keyed rendering', async () => {
  const { readonly, hub, control } = await fixture(3, 'NOCASE');
  control.reply = async response => {
    const page = await response.json() as any;
    page.rows[1].id = page.rows[0].id.toUpperCase();
    page.next_cursor = page.rows[1].id;
    return Response.json(page);
  };
  await expect(core.readRemoteRows(readonly, hub, { table: 'items', limit: 2 })).rejects.toThrow(/^invalid hub row response$/);
});

test('a page repeating or moving before its previous cursor is refused', async () => {
  const { readonly, hub, control } = await fixture(3);
  const first = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 2 });
  control.reply = async response => {
    const page = await response.json() as any;
    page.rows[0].id = 'row000';
    return Response.json(page);
  };
  await expect(core.readRemoteRows(readonly, hub, { table: 'items', limit: 2, cursor: first.nextCursor! })).rejects.toThrow(/^invalid hub row response$/);
});

test.each(['wrong identity', 'ambiguous'])('ID lookup refuses a %s response', async kind => {
  const { readonly, hub, control, requests } = await fixture(3);
  control.reply = async response => {
    const page = await response.json() as any;
    if (kind === 'wrong identity') page.rows[0].id = 'row099';
    else { page.rows.push({ ...page.rows[0], id: 'row001' }); page.next_cursor = 'row001'; }
    return Response.json(page);
  };
  await expect(core.readRemoteRow(readonly, hub, { table: 'items', id: 'row000' })).rejects.toThrow(/^invalid hub row response$/);
  expect(requests).toHaveLength(1);
});

test.each([null, {}, { table: 'items' }, { table: 'items', id: '' }, { table: 'items', id: 4 }, { table: 'items', id: 'one', where: {} }])('invalid ID lookup refuses before HTTP: %#', async args => {
  const { readonly, hub, requests } = await fixture(0);
  await expect(core.readRemoteRow(readonly, hub, args as any)).rejects.toThrow();
  expect(requests).toEqual([]);
});

test.each([
  "DELETE FROM _core_state WHERE key='hub'; DELETE FROM _sync_state WHERE key='hub_url'",
  "UPDATE _core_state SET value='https://other.test' WHERE key='hub'",
  "UPDATE _sync_state SET value='https://other.test' WHERE key='hub_url'",
  "UPDATE _sync_state SET value='' WHERE key='hub_url'",
])('endpoint binding rejects before any HTTP: %s', async sql => {
  const { db, readonly, hub, requests } = await fixture(0);
  db.db.exec(sql);
  const before = db.db.serialize();
  await expect(core.readRemoteRows(readonly, hub, { table: 'items' })).rejects.toThrow(/bound|hub/);
  await expect(core.readRemoteRow(readonly, hub, { table: 'items', id: 'one' })).rejects.toThrow(/bound|hub/);
  expect(requests).toEqual([]);
  expect(db.db.serialize()).toEqual(before);
});

test('a Python-only binding permits read-only browsing without initializing core metadata', async () => {
  const { db, readonly, hub, requests } = await fixture(1);
  db.db.exec('DROP TABLE _core_state');
  const before = db.db.serialize();
  expect((await core.readRemoteRows(readonly, hub, { table: 'items' })).rows).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(db.db.serialize()).toEqual(before);
});

test('an empty external database remains unbound and untouched', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  let calls = 0;
  const hub: core.Hub = { endpoint: 'https://example.test', async post() { calls++; throw new Error('must not send'); } };
  await expect(core.readRemoteRows(db, hub, { table: 'items' })).rejects.toThrow(/bound/);
  expect(await db.all('SELECT * FROM sqlite_master')).toEqual([]);
  expect(calls).toBe(0);
});

test('TEMP objects cannot impersonate the main schema or endpoint binding', async () => {
  const { db, readonly, hub, requests } = await fixture(1);
  db.db.exec("CREATE TEMP TABLE _sync_state(key,value); INSERT INTO temp._sync_state VALUES ('hub_url','https://other.test'); CREATE TEMP TABLE items(id TEXT PRIMARY KEY, private TEXT); CREATE TEMP TABLE catalog_tables(id,display,deleted_at)");
  expect((await core.readRemoteRows(readonly, hub, { table: 'items' })).rows[0].label).toBe('Item 0');
  expect(requests).toHaveLength(1);
});

test.each(['view', 'composite ID', 'integer ID', 'missing tombstone'])('unsupported physical schema %s refuses before HTTP', async kind => {
  const { db, readonly, hub, requests } = await fixture(0);
  db.db.exec('DROP TABLE items');
  if (kind === 'view') db.db.exec('CREATE VIEW items AS SELECT 1 AS id');
  if (kind === 'composite ID') db.db.exec('CREATE TABLE items(id TEXT,other TEXT,updated_at TEXT,deleted_at TEXT,PRIMARY KEY(id,other))');
  if (kind === 'integer ID') db.db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,updated_at TEXT,deleted_at TEXT)');
  if (kind === 'missing tombstone') db.db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,updated_at TEXT)');
  await expect(core.readRemoteRows(readonly, hub, { table: 'items' })).rejects.toThrow(/schema|columns/);
  expect(requests).toEqual([]);
});

test('native-style metadata object key order does not change cursor identity', async () => {
  const { readonly, hub } = await fixture(3);
  const all = readonly.all.bind(readonly);
  let reverse = false;
  readonly.all = async (sql, params) => {
    const rows = await all(sql, params);
    reverse = !reverse;
    return rows.map(row => Object.fromEntries(reverse ? Object.entries(row).reverse() : Object.entries(row)));
  };
  const first = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 2 });
  expect((await core.readRemoteRows(readonly, hub, { table: 'items', cursor: first.nextCursor! })).rows[0].record.id).toBe('row002');
});

test.each(['_sync_state', '_schema_log', 'sqlite_master', 'missing', 'items; SELECT 1'])('unknown or internal table %s sends no request', async table => {
  const { readonly, hub, requests } = await fixture(0);
  await expect(core.readRemoteRows(readonly, hub, { table })).rejects.toThrow();
  expect(requests).toEqual([]);
});

test.each([null, {}, { table: 'items', limit: 0 }, { table: 'items', limit: 201 }, { table: 'items', limit: 1.5 }, { table: 'items', limit: null }, { table: 'items', cursor: '' }, { table: 'items', cursor: 'private cursor' }, { table: 'items', search: 'unsupported' }, { table: 'items', columns: ['id'] }])('invalid request fails before HTTP: %#', async args => {
  const { readonly, hub, requests } = await fixture(0);
  await expect(core.readRemoteRows(readonly, hub, args as any)).rejects.toThrow();
  expect(requests).toEqual([]);
});

test.each([
  ['missing cursor', (page: any) => { delete page.next_cursor; }],
  ['extra row field', (page: any) => { page.rows[0].secret = 'private'; }],
  ['missing column', (page: any) => { delete page.rows[0].qty; }],
  ['nested value', (page: any) => { page.rows[0].name = { private: true }; }],
  ['non-string id', (page: any) => { page.rows[0].id = 1; }],
  ['duplicate id', (page: any) => { page.rows[1].id = page.rows[0].id; }],
  ['reversed rows', (page: any) => { page.rows.reverse(); page.next_cursor = page.rows.at(-1).id; }],
  ['cursor skips rows', (page: any) => { page.next_cursor = 'row099'; }],
  ['false terminal', (page: any) => { page.next_cursor = null; }],
  ['oversized page', (page: any) => { page.rows.push(page.rows[0]); }],
  ['invalid tombstone', (page: any) => { page.rows[0].deleted_at = 4; }],
  ['invalid revision', (page: any) => { page.rows[0].updated_at = 'private'; }],
] as const)('malformed receipt fails safely without changing local state: %s', async (_name, mutate) => {
  const { db, readonly, hub, requests, control, before } = await fixture(3);
  control.reply = async response => { const page = await response.json(); mutate(page); return Response.json(page); };
  await expect(core.readRemoteRows(readonly, hub, { table: 'items', limit: 2 })).rejects.toThrow(/^invalid hub row response$/);
  expect(requests).toHaveLength(1);
  expect(db.db.serialize()).toEqual(before);
});

test.each(['binding', 'schema', 'catalog', 'logged recreate'])('a %s change during HTTP invalidates the response', async change => {
  const { db, readonly, hub, control, requests } = await fixture(1);
  let afterExternalChange: ReturnType<typeof db.db.serialize>;
  control.reply = async response => {
    if (change === 'binding') db.db.exec("UPDATE _sync_state SET value='https://other.test' WHERE key='hub_url'");
    if (change === 'schema') db.db.exec('ALTER TABLE items ADD COLUMN extra TEXT');
    if (change === 'catalog') db.db.exec("UPDATE catalog_tables SET display='qty' WHERE id='items'");
    if (change === 'logged recreate') db.db.query('INSERT INTO _schema_log(ddl) VALUES (?)').run('CREATE TABLE placeholder(id TEXT)');
    afterExternalChange = db.db.serialize();
    return response;
  };
  await expect(core.readRemoteRows(readonly, hub, { table: 'items' })).rejects.toThrow(/changed/);
  expect(requests).toHaveLength(1);
  expect(db.db.serialize()).toEqual(afterExternalChange!);
});

test('cursors cannot cross endpoints, tables, or local schema revisions', async () => {
  const { db, readonly, hub, requests } = await fixture(3);
  const first = await core.readRemoteRows(readonly, hub, { table: 'items', limit: 1 });
  requests.length = 0;
  await expect(core.readRemoteRows(readonly, hub, { table: 'history', cursor: first.nextCursor! })).rejects.toThrow(/cursor/);
  const other = { ...hub, endpoint: 'https://other.test' };
  await db.run("UPDATE _core_state SET value=? WHERE key='hub'", [other.endpoint]);
  await db.run("UPDATE _sync_state SET value=? WHERE key='hub_url'", [other.endpoint]);
  await expect(core.readRemoteRows(readonly, other, { table: 'items', cursor: first.nextCursor! })).rejects.toThrow(/cursor/);
  await db.run("UPDATE _core_state SET value=? WHERE key='hub'", [hub.endpoint]);
  await db.run("UPDATE _sync_state SET value=? WHERE key='hub_url'", [hub.endpoint]);
  await db.run('ALTER TABLE items ADD COLUMN extra TEXT');
  await expect(core.readRemoteRows(readonly, hub, { table: 'items', cursor: first.nextCursor! })).rejects.toThrow(/cursor/);
  expect(requests).toEqual([]);
});

test('caps return one sanitized HTTP 429 with no retry or local changes', async () => {
  const { db, readonly, hub, requests, control, before } = await fixture(1);
  control.reply = async () => Response.json({ error: 'usage_cap', message: 'private usage details' }, { status: 429, headers: { 'Retry-After': '120' } });
  await expect(core.readRemoteRows(readonly, hub, { table: 'items' })).rejects.toThrow(/^hub HTTP 429$/);
  expect(requests).toHaveLength(1);
  await expect(core.readRemoteRow(readonly, hub, { table: 'items', id: 'row000' })).rejects.toThrow(/^hub HTTP 429$/);
  expect(requests).toHaveLength(2);
  expect(db.db.serialize()).toEqual(before);
});

test('failed HTTP never produces a partial page and never retries', async () => {
  const { db, readonly, hub, requests, control, before } = await fixture(1);
  control.reply = async () => new Response('private diagnostic', { status: 503 });
  await expect(core.readRemoteRows(readonly, hub, { table: 'items' })).rejects.toThrow(/^hub HTTP 503$/);
  expect(requests).toHaveLength(1);
  expect(db.db.serialize()).toEqual(before);
});

test('metadata failures are sanitized before credentials can be sent', async () => {
  const { readonly, hub, requests } = await fixture(0);
  readonly.all = async () => { throw new Error('private path and SQL'); };
  await expect(core.readRemoteRows(readonly, hub, { table: 'items' })).rejects.toThrow(/^remote table schema is unavailable; sync first$/);
  expect(requests).toEqual([]);
});

test('generated operation handlers invoke the same bounded remote reads', async () => {
  const { readonly, hub, requests } = await fixture(1);
  const handlers = core.createCoreHandlers(readonly, () => hub);
  expect((await handlers.remoteRows({ endpoint: hub.endpoint, table: 'items' })).rows).toHaveLength(1);
  expect((await handlers.remoteRow({ endpoint: hub.endpoint, table: 'items', id: 'row000' })).row?.label).toBe('Item 0');
  expect(requests).toHaveLength(2);
});
