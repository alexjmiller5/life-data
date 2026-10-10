import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import manifest from '../schema/saved-views.json';
import { schema, setup, TestSql, T0, T1 } from './support.ts';

const databases: { close(): void }[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function handlers(db: core.SqlDriver) {
  return core.createCoreHandlers(db, () => { throw new Error('Undo must not use a hub'); }, 'fixture');
}
async function local() {
  const db = new TestSql(); databases.push(db.db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,kind,display) VALUES ('items','table','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text'),('items.qty','items','qty','int')");
  await db.run('INSERT INTO items(id,name,qty,created_at,updated_at) VALUES (?,?,?,?,?)', ['a','Before',3,T0,T0]);
  return { db, h: handlers(db) };
}
async function action(h: core.CoreHandlers) {
  const status = await h.undoStatus({});
  expect(status.action).not.toBeNull();
  return status.action!;
}
async function edit(h: core.CoreHandlers, patch: core.Row = { name: 'After', qty: 4 }) {
  return h.write({ table: 'items', patch: { id: 'a', ...patch } });
}
async function state(db: TestSql) {
  return {
    items: await db.all('SELECT * FROM items ORDER BY id'),
    history: await db.all('SELECT * FROM history ORDER BY id'),
    pending: await db.all('SELECT * FROM _core_pending ORDER BY tbl,row_id'),
    temp: await db.all('SELECT name FROM temp.sqlite_master ORDER BY name'),
  };
}
async function rejects(promise: unknown, rule: string) {
  try { await promise; throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(core.ValidationError);
    expect((error as core.ValidationError).violations.some(v => v.rule === rule)).toBe(true);
  }
}

test('edit undo restores actual SQLite values and journals a new validated revision', async () => {
  const { db, h } = await local();
  expect(await h.undoStatus({})).toEqual({ action: null });
  const saved = await edit(h, { name: null, qty: '04' });
  const receipt = await action(h);
  expect(receipt).toEqual({ receiptId: expect.any(String), table: 'items', rowId: 'a', kind: 'edit' });
  const undone = await h.undo({ receiptId: receipt.receiptId });
  expect(undone).toMatchObject({ id: 'a', name: 'Before', qty: 3, created_at: T0, deleted_at: null });
  expect(String(undone.updated_at) > String(saved.updated_at)).toBe(true);
  expect(await db.all('SELECT col,old,new FROM history ORDER BY updated_at,col')).toEqual([
    { col: 'name', old: 'Before', new: null }, { col: 'qty', old: '3', new: '4' },
    { col: 'name', old: null, new: 'Before' }, { col: 'qty', old: '4', new: '3' },
  ]);
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: 'a', updated_at: undone.updated_at }]);
  expect(await h.undoStatus({})).toEqual({ action: null });
  await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
});

test('create undo trashes the new row and keeps its defaults, creation stamp and identity', async () => {
  const { db, h } = await local();
  await db.run("UPDATE catalog_properties SET default_value='7' WHERE col='qty'");
  const created = await h.write({ table: 'items', patch: { name: 'Created' } });
  const receipt = await action(h);
  expect(receipt.kind).toBe('create');
  const undone = await h.undo({ receiptId: receipt.receiptId });
  expect(undone).toMatchObject({ id: created.id, name: 'Created', qty: 7, created_at: created.created_at });
  expect(undone.deleted_at).toBe(undone.updated_at);
  expect(String(undone.updated_at) > String(created.updated_at)).toBe(true);
  expect(await db.all('SELECT col,old,new FROM history')).toEqual([{ col: 'deleted_at', old: null, new: undone.deleted_at }]);
});

test.each([false, true])('trash undo restores fields too when combined edit=%s', async combined => {
  const { h } = await local();
  const saved = await edit(h, { deleted_at: true, ...(combined ? { name: null, qty: 9 } : {}) });
  const receipt = await action(h);
  expect(receipt.kind).toBe('trash');
  const undone = await h.undo({ receiptId: receipt.receiptId });
  expect(undone).toMatchObject({ name: 'Before', qty: 3, deleted_at: null });
  expect(String(undone.updated_at) > String(saved.updated_at)).toBe(true);
});

test.each([false, true])('restore undo uses a fresh tombstone and reverses combined edit=%s', async combined => {
  const { db, h } = await local();
  await db.run('UPDATE items SET deleted_at=?', [T0]);
  const saved = await edit(h, { deleted_at: null, ...(combined ? { name: 'Restored', qty: 9 } : {}) });
  const receipt = await action(h);
  expect(receipt.kind).toBe('restore');
  const undone = await h.undo({ receiptId: receipt.receiptId });
  expect(undone).toMatchObject({ name: 'Before', qty: 3, created_at: T0 });
  expect(undone.deleted_at).toBe(undone.updated_at);
  expect(String(undone.updated_at) > String(saved.updated_at)).toBe(true);
  expect(undone.deleted_at).not.toBe(T0);
});

test('autosaves form an ordered undo stack and earlier handles cannot skip a save', async () => {
  const { db, h } = await local();
  const first = await edit(h, { name: 'First save' });
  const previous = await action(h);
  await h.write({ table: 'items', patch: { id: 'a', name: 'Second save' }, expectedUpdatedAt: String(first.updated_at) });
  const current = await action(h);
  expect(current.receiptId).not.toBe(previous.receiptId);
  const before = await state(db);
  await rejects(h.undo({ receiptId: previous.receiptId }), 'conflict');
  expect(await state(db)).toEqual(before);
  expect(await action(h)).toEqual(current);
  expect((await h.undo({ receiptId: current.receiptId })).name).toBe('First save');
  expect(await action(h)).toEqual(previous);
  expect((await h.undo({ receiptId: previous.receiptId })).name).toBe('Before');
  expect(await h.undoStatus({})).toEqual({ action: null });
});

test('timestamp-only writes retain human undo after SQLite affinity normalizes input', async () => {
  const { h } = await local();
  const saved = await edit(h);
  const previous = await action(h);
  const same = await edit(h, { name: 'After', qty: '04' });
  expect(String(same.updated_at) > String(saved.updated_at)).toBe(true);
  expect(await action(h)).toEqual(previous);
  expect((await h.undo({receiptId: previous.receiptId})).name).toBe('Before');
});

test('failed writes retain the previous receipt and leave database state unchanged', async () => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h), before = await state(db);
  await rejects(edit(h, { qty: 'invalid' }), 'type');
  expect(await action(h)).toEqual(receipt);
  expect(await state(db)).toEqual(before);
  expect((await h.undo({ receiptId: receipt.receiptId })).qty).toBe(3);
});

test.each([
  ["UPDATE catalog_properties SET immutable=1 WHERE col='name'", 'immutable'],
  ["UPDATE catalog_properties SET derived_by='fixture' WHERE col='name'", 'derived'],
  ["UPDATE catalog_properties SET type='select',options='[\"After\"]' WHERE col='name'", 'catalog'],
  ["UPDATE catalog_properties SET type='select',options='[{\"v\":\"After\"}]' WHERE col='name'", 'options'],
  ["INSERT INTO catalog_rules(id,tbl,kind,enforce,sql) VALUES ('r','items','invariant',1,'SELECT id FROM changed WHERE 0')", 'coverage'],
])('undo rechecks changed catalog: %s', async (sql, rule) => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h);
  await db.run(sql);
  const before = await state(db);
  await rejects(h.undo({ receiptId: receipt.receiptId }), rule);
  expect(await action(h)).toEqual(receipt);
  expect(await state(db)).toEqual(before);
});

test('shape changes reject undo without touching stored data or consuming the receipt', async () => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h);
  await db.run('ALTER TABLE items ADD COLUMN additional TEXT');
  const before = await state(db);
  await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
  expect(await state(db)).toEqual(before);
  expect(await action(h)).toEqual(receipt);
});

test('a newer revision conflicts even when another writer edited a different field', async () => {
  const { db, h } = await local();
  await edit(h, { name: 'After' });
  const receipt = await action(h);
  await core.writeRow(db, 'items', { id: 'a', qty: 8 });
  const before = await state(db);
  await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
  expect(await state(db)).toEqual(before);
  expect(await action(h)).toEqual(receipt);
});

test('undo does not restore untouched fields that become immutable after the edit', async () => {
  const { db, h } = await local();
  await edit(h, { name: 'After', qty: '03' });
  const receipt = await action(h);
  await db.run("UPDATE catalog_properties SET immutable=1 WHERE col='qty'");
  expect(await h.undo({ receiptId: receipt.receiptId })).toMatchObject({ name: 'Before', qty: 3 });
});

test('receipt status and returned rows cannot mutate private undo data', async () => {
  const { h } = await local();
  const saved = await edit(h);
  const receipt = await action(h), id = receipt.receiptId;
  saved.updated_at = T0; saved.name = 'Forged';
  receipt.receiptId = 'forged'; receipt.table = 'history'; receipt.rowId = 'other';
  expect((await action(h)).receiptId).toBe(id);
  expect(await h.undo({ receiptId: id })).toMatchObject({ name: 'Before', qty: 3 });
});

test.each([null, {}, { receiptId: '' }, { receiptId: 1 }, { receiptId: ' ' }, { receiptId: 'not-the-receipt' }, { receiptId: 'x', patch: {} }])('invalid undo request retains slot: %j', async args => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h), before = await state(db);
  await expect(h.undo(args as core.UndoArgs)).rejects.toBeInstanceOf(core.ValidationError);
  expect(await action(h)).toEqual(receipt);
  expect(await state(db)).toEqual(before);
});

test('handlers isolate receipts even on the same DB; recreating the session does not recover history', async () => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h), other = handlers(db);
  expect(await other.undoStatus({})).toEqual({ action: null });
  await rejects(other.undo({ receiptId: receipt.receiptId }), 'conflict');
  expect(await action(h)).toEqual(receipt);
  const next = await edit(other, { qty: 6 });
  expect((await action(other)).receiptId).not.toBe(receipt.receiptId);
  await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
  expect(next.qty).toBe(6);
});

test('normal search queues reflect inverse writes and do not make receipts stale', async () => {
  const { db, h } = await local();
  await edit(h, { name: 'After' });
  const receipt = await action(h);
  expect((await h.search({ table: 'items', text: 'After' })).map(r => r.id)).toEqual(['a']);
  await h.undo({ receiptId: receipt.receiptId });
  expect(await h.search({ table: 'items', text: 'After' })).toEqual([]);
  expect((await h.search({ table: 'items', text: 'Before' })).map(r => r.id)).toEqual(['a']);
  expect(await db.all('SELECT * FROM _core_search_dirty')).toEqual([]);
});

async function provisionViews(db: TestSql) {
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
  for (const ddl of manifest.ddl) await db.run(ddl);
  const t = manifest.table;
  await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)', [t.id,t.kind,t.display]);
  for (const p of manifest.properties) {
    const keys = Object.keys(p);
    await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(p) as core.Value[]);
  }
}

test('undo never restores or renames a view onto a live name', async () => {
  const {db,h}=await local(); await provisionViews(db);
  const copy=await h.saveView({table:'items',name:'Daily',definition:{version:1}});
  await h.deleteView({id:copy.id,expectedUpdatedAt:copy.updated_at!});
  const restore=await action(h);
  // The name is taken again (another device synced one) before Undo runs.
  await db.run("INSERT INTO views(id,name,tbl,definition,updated_at) VALUES ('synced',' daily','items','{\"version\":1}',?)",[T0]);
  await expect(h.undo({receiptId:restore.receiptId})).rejects.toThrow(/already named/);
  expect((await db.all('SELECT deleted_at FROM views WHERE id=?',[copy.id]))[0]!.deleted_at).not.toBeNull();
  expect(await action(h)).toEqual(restore);
  const view=await h.saveView({table:'items',name:'Weekly',definition:{version:1}});
  await h.saveView({table:'items',id:view.id,expectedUpdatedAt:view.updated_at!,name:'Monthly',definition:{version:1}});
  const renamed=await action(h);
  await db.run("INSERT INTO views(id,name,tbl,definition,updated_at) VALUES ('synced-2','WEEKLY','items','{\"version\":1}',?)",[T0]);
  await expect(h.undo({receiptId:renamed.receiptId})).rejects.toThrow(/already named/);
  expect((await db.all('SELECT name FROM views WHERE id=?',[view.id]))[0]!.name).toBe('Monthly');
  // Undo that keeps a legacy duplicate's own name still works.
  await db.run("UPDATE views SET deleted_at=?, updated_at=? WHERE id='synced-2'",[T1,T1]);
  const back=await h.undo({receiptId:renamed.receiptId});
  expect(back.name).toBe('Weekly');
  // A legacy duplicate does not block undoing an edit that keeps the view's own name.
  await db.run("INSERT INTO views(id,name,tbl,definition,updated_at) VALUES ('synced-3','weekly','items','{\"version\":1}',?)",[T0]);
  const current=(await h.listViews({table:'items'})).views.find(v=>v.id===view.id)!;
  await h.saveView({table:'items',id:view.id,expectedUpdatedAt:current.updated_at!,name:'Weekly',definition:{version:1,columns:['name']}});
  const edited=await action(h);
  expect(JSON.parse(String((await h.undo({receiptId:edited.receiptId})).definition))).toEqual({version:1});
});

test('saved views join the same undo stack and failed mutations leave it intact', async () => {
  const {db,h}=await local(); await provisionViews(db); await edit(h);
  const recordUndo=await action(h);
  await expect(h.saveView({table:'items',name:'',definition:{version:1}})).rejects.toThrow();
  expect(await action(h)).toEqual(recordUndo);
  const view=await h.saveView({table:'items',name:'Example',definition:{version:1}});
  const created=await action(h); expect(created.table).toBe('views');
  const updated=await h.saveView({table:'items',id:view.id,expectedUpdatedAt:view.updated_at!,name:'Renamed',definition:{version:1}});
  const renamed=await action(h);
  await expect(h.deleteView({id:view.id,expectedUpdatedAt:T0})).rejects.toThrow();
  expect(await action(h)).toEqual(renamed);
  await h.deleteView({id:view.id,expectedUpdatedAt:updated.updated_at!});
  await h.undo({receiptId:(await action(h)).receiptId});
  expect((await h.listViews({table:'items'})).views[0]!.name).toBe('Renamed');
  await h.undo({receiptId:renamed.receiptId});
  expect((await h.listViews({table:'items'})).views[0]!.name).toBe('Example');
  await h.undo({receiptId:created.receiptId});
  expect((await h.listViews({table:'items'})).views).toEqual([]);
  expect(await action(h)).toEqual(recordUndo);
  expect((await h.undo({receiptId:recordUndo.receiptId})).name).toBe('Before');
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test.each(['write', 'undo'])('failed %s COMMIT rolls back rows, history, pending, FTS and retains prior receipt', async operation => {
  const { db, h } = await local();
  await h.search({ table: 'items', text: 'Before' });
  await edit(h);
  const receipt = await action(h), before = await state(db);
  const dirty = await db.all('SELECT * FROM _core_search_dirty');
  const transaction = db.transaction.bind(db);
  db.transaction = body => transaction(async () => { await body(); throw new Error('simulated COMMIT failure'); });
  await rejects(operation === 'write' ? edit(h, { name: 'Never committed' }) : h.undo({ receiptId: receipt.receiptId }), 'storage');
  db.transaction = transaction;
  expect(await action(h)).toEqual(receipt);
  expect(await state(db)).toEqual(before);
  expect(await db.all('SELECT * FROM _core_search_dirty')).toEqual(dirty);
  expect((await h.undo({ receiptId: receipt.receiptId })).name).toBe('Before');
});

test('status waits for COMMIT and direct concurrent writes publish receipts in commit order', async () => {
  const { db, h } = await local();
  const entered = gate(), release = gate();
  const transaction = db.transaction.bind(db);
  let first = true;
  db.transaction = body => transaction(async () => {
    const result = await body();
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  });
  const writing = edit(h, { name: 'First' });
  await entered.promise;
  let published = false;
  const status = Promise.resolve(h.undoStatus({})).then(s => { published = true; return s; });
  const second = edit(h, { name: 'Second' });
  await Promise.resolve(); await Promise.resolve();
  expect(published).toBe(false);
  release.resolve();
  await writing;
  const earlier = (await status).action!;
  await second;
  const later = await action(h);
  expect(later.receiptId).not.toBe(earlier.receiptId);
  expect((await h.undo({ receiptId: later.receiptId })).name).toBe('First');
});

test('concurrent undo and write cannot consume the newer receipt or nest transactions', async () => {
  const { h } = await local();
  await edit(h);
  const receipt = await action(h);
  const [undone, written] = await Promise.all([
    h.undo({ receiptId: receipt.receiptId }), edit(h, { name: 'Next' }),
  ]);
  expect(undone.name).toBe('Before'); expect(written.name).toBe('Next');
  const next = await action(h);
  expect((await h.undo({ receiptId: next.receiptId })).name).toBe('Before');
});

test('queued arguments are snapshotted before awaiting, including nested JSON input', async () => {
  const { db, h } = await local();
  await db.run('ALTER TABLE items ADD COLUMN payload TEXT');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.payload','items','payload','json')");
  const entered = gate(), release = gate();
  const transaction = db.transaction.bind(db);
  let first = true;
  db.transaction = body => transaction(async () => {
    const result = await body();
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  });
  const writing = edit(h);
  await entered.promise;
  const input = { table: 'items', patch: { id: 'a', name: 'Queued', payload: { text: 'Original' } } };
  const queued = h.write(input);
  input.patch.name = 'Mutated'; input.patch.payload.text = 'Mutated';
  release.resolve(); await writing;
  expect(await queued).toMatchObject({ name: 'Queued', payload: '{"text":"Original"}' });
});

test('undo receipt revision and after-image reject changes without a proper revision bump', async () => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h);
  await db.run("UPDATE items SET qty=100 WHERE id='a'");
  const before = await state(db);
  await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
  expect(await state(db)).toEqual(before);
  expect(await action(h)).toEqual(receipt);
});

async function synced(rule?: string) {
  const fixture = setup(); databases.push(fixture.db.db, fixture.remote.db);
  const { db, hub, remote } = fixture;
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.name','items','name','text',T0,T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.qty','items','qty','int',T0,T1);
  remote.db.query('INSERT INTO items(id,name,qty,created_at,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('a','Before',3,T0,T0,T1);
  if (rule) remote.db.query('INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('r','items','invariant',1,rule,T0,T1);
  await core.sync(db, hub);
  return { ...fixture, h: handlers(db) };
}

test('own sync acknowledgment keeps undo, which round trips through the real hub and a fresh replica', async () => {
  const { db, hub, remote, h } = await synced();
  const saved = await edit(h);
  const receipt = await action(h);
  expect((await core.sync(db, hub)).rejected).toEqual([]);
  expect(remote.db.query('SELECT hub_at FROM items').get()).not.toEqual({ hub_at: saved.hub_at });
  expect(await action(h)).toEqual(receipt);
  const undone = await h.undo({ receiptId: receipt.receiptId });
  expect(undone).toMatchObject({ name: 'Before', qty: 3 });
  expect((await core.sync(db, hub)).rejected).toEqual([]);
  expect(remote.db.query('SELECT name,qty FROM items').get()).toEqual({ name: 'Before', qty: 3 });
  const other = new TestSql(); databases.push(other.db);
  await core.sync(other, hub);
  expect(await other.all('SELECT name,qty FROM items')).toEqual([{ name: 'Before', qty: 3 }]);
  expect(await other.all('SELECT id,col,old,new FROM history ORDER BY id')).toEqual(await db.all('SELECT id,col,old,new FROM history ORDER BY id'));
});

test('newer row pulled from the real hub prevents undo and preserves its receipt', async () => {
  const { db, hub, h } = await synced();
  const saved = await edit(h);
  await core.sync(db, hub);
  const receipt = await action(h);
  const changed = { ...saved, qty: 9, updated_at: new Date(Date.parse(String(saved.updated_at)) + 100).toISOString() };
  const accepted = await hub.post('/v1/rows/push', { table: 'items', columns: Object.keys(changed), rows: [changed] });
  expect((accepted.data as { rejected: unknown[] }).rejected).toEqual([]);
  await core.sync(db, hub);
  expect((await db.all('SELECT qty FROM items'))[0].qty).toBe(9);
  const before = await state(db);
  await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
  expect(await state(db)).toEqual(before);
  expect(await action(h)).toEqual(receipt);
});

test.each(['invariant', 'coverage'])('undo rolls back through ordinary %s validation', async reason => {
  const { db, hub, h } = await synced('SELECT id FROM changed WHERE qty < 4');
  await edit(h, { qty: 4 });
  const receipt = await action(h);
  if (reason === 'coverage') await core.sync(db, hub, { tables: { history: false } });
  const before = await state(db);
  await rejects(h.undo({ receiptId: receipt.receiptId }), reason === 'invariant' ? 'r' : reason);
  expect(await state(db)).toEqual(before);
  expect(await action(h)).toEqual(receipt);
});

test('another client may update hub_at bookkeeping without invalidating the captured user revision', async () => {
  const { db, h } = await local();
  await edit(h);
  const receipt = await action(h);
  await db.run('UPDATE items SET hub_at=?', [T1]);
  expect(await h.undo({ receiptId: receipt.receiptId })).toMatchObject({ name: 'Before', hub_at: T1 });
});

test('cataloged __proto__ column is inverted as ordinary data', async () => {
  const { db, h } = await local();
  await db.run('ALTER TABLE items ADD COLUMN "__proto__" TEXT');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.proto','items','__proto__','text')");
  await db.run('UPDATE items SET "__proto__"=?', ['Before']);
  await edit(h, JSON.parse('{"__proto__":"After"}'));
  const receipt = await action(h);
  const undone = await h.undo({ receiptId: receipt.receiptId });
  expect(Object.hasOwn(undone, '__proto__')).toBe(true);
  expect(undone.__proto__).toBe('Before');
});

test('a revision-only change still rejects undo through the normal stale guard', async () => {
  const { db, h } = await local();
  const row = await edit(h);
  const receipt = await action(h);
  await db.run('UPDATE items SET updated_at=?', [new Date(Date.parse(String(row.updated_at)) + 1).toISOString()]);
  const before = await state(db);
  try { await h.undo({ receiptId: receipt.receiptId }); throw new Error('Expected revision conflict'); }
  catch (error) {
    expect(error).toBeInstanceOf(core.ValidationError);
    expect((error as core.ValidationError).violations[0]).toMatchObject({ rule: 'conflict', col: 'updated_at' });
  }
  expect(await action(h)).toEqual(receipt);
  expect(await state(db)).toEqual(before);
});

test.each(['create', 'trash', 'restore'])('FTS live results reflect %s and its inverse', async kind => {
  const { db, h } = await local();
  if (kind === 'restore') await db.run('UPDATE items SET deleted_at=?', [T0]);
  await h.search({ table: 'items', text: 'Needle' });
  if (kind === 'create') await h.write({ table: 'items', patch: { name: 'Needle' } });
  else await edit(h, { name: 'Needle', deleted_at: kind === 'trash' ? true : null });
  const receipt = await action(h);
  expect((await h.search({ table: 'items', text: 'Needle' })).length).toBe(kind === 'trash' ? 0 : 1);
  await h.undo({ receiptId: receipt.receiptId });
  expect(await h.search({ table: 'items', text: 'Needle' })).toEqual([]);
  expect((await h.search({ table: 'items', text: 'Before' })).length).toBe(kind === 'restore' ? 0 : 1);
});

test('closing and reopening a persisted workspace starts with no receipt but keeps data and history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'life-undo-'));
  const db = new TestSql();
  db.db.close();
  const path = join(directory, 'replica.db');
  db.db = new Database(path);
  try {
    for (const ddl of schema) await db.run(ddl);
    await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text')");
    let h = handlers(db);
    const row = await h.write({ table: 'items', patch: { name: 'Created' } });
    await h.write({ table: 'items', patch: { id: row.id, name: 'Edited' } });
    const receipt = await action(h), before = await state(db);
    db.db.close(); db.db = new Database(path);
    h = handlers(db);
    expect(await h.undoStatus({})).toEqual({ action: null });
    await rejects(h.undo({ receiptId: receipt.receiptId }), 'conflict');
    expect(await state(db)).toEqual(before);
  } finally { db.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('invalid receipt getters are never invoked and cannot alter the stored action', async () => {
  const { h } = await local();
  await edit(h);
  const receipt = await action(h);
  let reads = 0;
  await rejects(h.undo({ get receiptId() { reads++; return receipt.receiptId; } }), 'input');
  expect(reads).toBe(0);
  expect(await action(h)).toEqual(receipt);
});


test('repeated undo traverses interleaved rows without losing earlier edits', async () => {
  const { h } = await local();
  await edit(h, {name:'First'});
  const first=await action(h);
  const created=await h.write({table:'items',patch:{name:'Second row',qty:2}});
  const creation=await action(h);
  await edit(h, {name:'Last'});
  await h.undo({receiptId:(await action(h)).receiptId});
  expect(await action(h)).toEqual(creation);
  expect((await h.undo({receiptId:creation.receiptId})).deleted_at).not.toBeNull();
  expect(await action(h)).toEqual(first);
  expect((await h.undo({receiptId:first.receiptId})).name).toBe('Before');
  expect(await h.undoStatus({})).toEqual({action:null});
});

test('undo create-edit-trash-restore keeps every human action reversible', async () => {
  const { h } = await local();
  const created=await h.write({table:'items',patch:{name:'New',qty:2}});
  const ids=[];
  ids.push((await action(h)).receiptId);
  for(const patch of [{name:'Edited'},{deleted_at:true},{deleted_at:null}]) {
    await h.write({table:'items',patch:{id:created.id,...patch}});
    ids.push((await action(h)).receiptId);
  }
  const restored=await h.undo({receiptId:ids.pop()!});
  expect(restored.deleted_at).not.toBeNull();
  const trashed=await h.undo({receiptId:ids.pop()!});
  expect(trashed).toMatchObject({name:'Edited',deleted_at:null});
  expect((await h.undo({receiptId:ids.pop()!})).name).toBe('New');
  expect((await h.undo({receiptId:ids.pop()!})).deleted_at).not.toBeNull();
});

test('older undo cannot adopt an external edit hidden between two local edits', async () => {
  const {db,h}=await local();
  await edit(h,{name:'First'});
  const first=await action(h);
  await core.writeRow(db,'items',{id:'a',qty:88});
  await edit(h,{name:'Second'});
  await h.undo({receiptId:(await action(h)).receiptId});
  const before=await state(db);
  await rejects(h.undo({receiptId:first.receiptId}),'conflict');
  expect(await state(db)).toEqual(before);
});

test('failed saved-view COMMIT publishes no receipt and preserves preceding undo', async () => {
  const {db,h}=await local(); await provisionViews(db); await edit(h);
  const previous=await action(h), transaction=db.transaction.bind(db);
  db.transaction=body=>transaction(async()=>{await body();throw new Error('COMMIT failed');});
  await expect(h.saveView({table:'items',name:'Never committed',definition:{version:1}})).rejects.toThrow();
  db.transaction=transaction;
  expect(await action(h)).toEqual(previous);
  expect((await h.listViews({table:'items'})).views).toEqual([]);
});

test('bounded undo stack retains the newest hundred human changes', async () => {
  const {h}=await local();
  for(let i=0;i<103;i++) await edit(h,{name:`Edit ${i}`});
  for(let i=102;i>=3;i--) expect((await h.undo({receiptId:(await action(h)).receiptId})).name).toBe(`Edit ${i-1}`);
  expect(await h.undoStatus({})).toEqual({action:null});
});

test('saved-view undo rejects a now-invalid definition without consuming the action', async () => {
  const {db,h}=await local(); await provisionViews(db);
  const view=await h.saveView({table:'items',name:'Filtered',definition:{version:1,filters:[{column:'qty',op:'eq',value:3}]}});
  await h.deleteView({id:view.id,expectedUpdatedAt:view.updated_at!});
  const previous=await action(h);
  await db.run("DELETE FROM catalog_properties WHERE col='qty'");
  await expect(h.undo({receiptId:previous.receiptId})).rejects.toThrow();
  expect(await action(h)).toEqual(previous);
  expect((await db.all('SELECT deleted_at FROM views WHERE id=?',[view.id]))[0]!.deleted_at).not.toBeNull();
});
