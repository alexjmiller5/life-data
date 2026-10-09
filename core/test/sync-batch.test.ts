import { expect, test } from 'bun:test';
import { sync } from '../src/sync.ts';
import type { SyncProgress } from '../src/driver.ts';
import { setup, T0, T1, T2 } from './support.ts';

// A cold replica downloads tens of tables; each request pays the hub's fixed
// cost, so pages travel in batches the hub advertises, and a round asks only
// the tables whose newest arrival reached the replica's cursor.
const pulls = (requests: { route: string; body: any }[]) => requests.filter(r => r.route === '/v1/rows/pull');
const items = (requests: { route: string; body: any }[]) => pulls(requests).flatMap(r => r.body.batch ?? [r.body]);
const local = (db: any, table: string) => db.all(`SELECT * FROM ${table} ORDER BY id`);
const remoteRows = (remote: any, table: string) => remote.db.query(`SELECT * FROM ${table} ORDER BY id`).all();

function estate(remote: any, n = 450) {
  const item = remote.db.query('INSERT INTO items(id,name,qty,updated_at,hub_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < n; i++) item.run(String(i).padStart(4, '0'), `Item ${i}`, i, T0, T1);
  const event = remote.db.query('INSERT INTO history(id,tbl,row_id,col,old,new,updated_at,hub_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 30; i++) event.run(`h${i}`, 'items', String(i).padStart(4, '0'), 'name', 'a', 'b', T0, T1);
}

test('a cold start downloads every table in a few batched requests and matches a page-by-page replica', async () => {
  const batched = setup({ batch: true }), paged = setup();
  for (const s of [batched, paged]) estate(s.remote);
  await sync(batched.db, batched.hub);
  await sync(paged.db, paged.hub);
  for (const table of ['items', 'history', 'catalog_properties', 'catalog_rules']) {
    expect(await local(batched.db, table)).toEqual(await local(paged.db, table));
    expect((await local(batched.db, table)).length).toBe(remoteRows(batched.remote, table).length);
  }
  expect(pulls(paged.requests).length).toBe(6); // items 3 pages, one each for the rest
  expect(pulls(batched.requests).length).toBe(1);
  expect(await batched.db.all('SELECT tbl,pull FROM _core_sync ORDER BY tbl')).toEqual(await paged.db.all('SELECT tbl,pull FROM _core_sync ORDER BY tbl'));
});

for (const batch of [false, true]) test(`an incremental round asks only the tables that changed (${batch ? 'batched' : 'paged'})`, async () => {
  const { db, remote, hub, requests } = setup({ batch });
  estate(remote, 10);
  await sync(db, hub);
  const asked = async () => { requests.length = 0; const round = await sync(db, hub); return { round, asked: items(requests).map(i => [i.table, i.since]) }; };
  // The cursor is the round's newest arrival; the tables holding it are quiet
  // too while the hub holds as many rows at that mark as were pulled.
  expect((await asked()).asked).toEqual([]);
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('new', 'New', T1, T2);
  const { round, asked: changed } = await asked();
  expect(changed).toEqual([['items', T1]]);
  expect(round.pulled).toBe(1);
  expect((await asked()).asked).toEqual([]);
  // A quiet table keeps its cursor and its coverage.
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='history'")).toEqual([{ pull: T1 }]);
  expect(await db.all("SELECT pull FROM _core_coverage WHERE tbl='history'")).toEqual([{ pull: T1 }]);
  expect(await local(db, 'items')).toEqual(remoteRows(remote, 'items'));
});

test('a hub answering only part of a batch (its byte budget) is resumed from what it sent', async () => {
  const { db, remote, hub, requests } = setup({ batch: true });
  estate(remote);
  // Keep one page per reply and cut it to 50 rows, as the byte budget would.
  const trimming = { ...hub, async post(route: string, body: any) {
    const reply: any = await hub.post(route, body);
    if (route !== '/v1/rows/pull') return reply;
    const [page] = reply.data.batch;
    const rows = page.rows.slice(0, 50);
    return { ...reply, data: { batch: [{ rows, next_cursor: page.rows.length > 50 ? rows.at(-1).id : page.next_cursor }] } };
  } };
  await sync(db, trimming);
  expect(await local(db, 'items')).toEqual(remoteRows(remote, 'items'));
  expect(await local(db, 'history')).toEqual(remoteRows(remote, 'history'));
  expect(pulls(requests).length).toBeGreaterThan(9);
});

test('a failed batch keeps finished tables and resumes the interrupted one at its last page', async () => {
  const { db, remote, hub, requests } = setup({ batch: true });
  estate(remote, 6000);
  let calls = 0;
  const failing = { ...hub, async post(route: string, body: any) {
    if (route === '/v1/rows/pull' && ++calls === 2) throw new Error('offline');
    return hub.post(route, body);
  } };
  await expect(sync(db, failing)).rejects.toThrow('offline');
  // The first request finished the catalog and fetched the first items page.
  expect(await db.all("SELECT tbl FROM _core_sync WHERE tbl GLOB 'catalog_*' ORDER BY tbl")).toEqual([{ tbl: 'catalog_properties' }, { tbl: 'catalog_rules' }]);
  const [{ after }] = await db.all("SELECT after FROM _core_pull_progress WHERE tbl='items'");
  expect(after).toBeTruthy();
  requests.length = 0;
  await sync(db, hub);
  expect(items(requests).find(i => i.table === 'items')).toMatchObject({ since: '', after });
  expect(await local(db, 'items')).toEqual(remoteRows(remote, 'items'));
});

test('a prefetched page still defers a newer remote row behind a pending local edit', async () => {
  const { db, remote, hub } = setup({ batch: true });
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('p', 'Old', T0, T1);
  await sync(db, hub);
  await db.run("UPDATE items SET name='Mine', updated_at=? WHERE id='p'", [T1]);
  await db.run("INSERT INTO _core_pending(tbl,row_id,updated_at) VALUES ('items','p',?)", [T1]);
  remote.db.query("UPDATE items SET name='Theirs', updated_at=?, hub_at=? WHERE id='p'").run(T2, T2);
  await sync(db, hub);
  // Deferred: the pull cursor stays so the remote row replays after our receipt.
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='items'")).toEqual([{ pull: T1 }]);
  await sync(db, hub);
  expect(await db.all("SELECT name FROM items WHERE id='p'")).toEqual([{ name: 'Theirs' }]);
});

test('progress counts finished tables and received rows against the full pulls expected', async () => {
  const { db, remote, hub } = setup({ batch: true });
  estate(remote, 300);
  const seen: SyncProgress[] = [];
  await sync(db, { ...hub, progress: (p: SyncProgress) => seen.push(p) });
  const last = seen.at(-1)!;
  expect(seen[0]).toMatchObject({ tablesDone: 0, tablesTotal: 4, rowsReceived: 0 });
  expect(last).toMatchObject({ tablesDone: 4, tablesTotal: 4, rowsReceived: 330, rowsExpected: 330 });
  expect(seen.some(p => p.table === 'items' && p.rowsReceived > 0)).toBe(true);
  seen.length = 0;
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('new', 'New', T1, T2);
  await sync(db, { ...hub, progress: (p: SyncProgress) => seen.push(p) });
  expect(seen.at(-1)).toMatchObject({ tablesDone: 4, tablesTotal: 4, rowsExpected: null });
  expect(seen.some(p => p.table === 'catalog_rules')).toBe(true); // quiet tables still count as done
});
