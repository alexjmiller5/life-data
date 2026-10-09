import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BackupInvalid, DUMP_HEADER, exportReplica, listHubBackups, previewRestore, replicaSummary, restoreReplica, validateBackup, type BackupFiles, type DumpSource } from '../src/backup.ts';
import { createCoreHandlers } from '../src/operations.ts';
import { initCore } from '../src/sync.ts';
import { TestSql, T0, T1, T2, schema } from './support.ts';

const ITEMS = 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, qty INTEGER, score REAL, data BLOB, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)';
const TRIGGER = `CREATE TRIGGER "items_updated_at" AFTER UPDATE ON "items" FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE "items" SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid; END`;
const TRICKY = "it's\nmultiline;\r\n -- not a comment ; END; 'q' ünï 😀";

async function replica(rows: [string, string, string | null][] = [['a', TRICKY, null], ['b', 'Bee', T2]]) {
  const db = new TestSql();
  await initCore(db);
  for (const ddl of [ITEMS, 'CREATE INDEX items_name ON items(name)', TRIGGER, 'CREATE VIEW live_items AS SELECT id FROM items WHERE deleted_at IS NULL']) {
    db.db.exec(ddl);
    if (!/^CREATE (INDEX|VIEW)/.test(ddl)) db.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  }
  const insert = db.db.query('INSERT INTO items(id,name,qty,score,data,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?)');
  rows.forEach(([id, name, deleted], i) => insert.run(id, name, 9007199254740991 - i, i + 0.1, new Uint8Array([0, 255, i]), T0, i ? T1 : T2, deleted));
  return db;
}

function memoryFiles(seed: Record<string, string> = {}, chunk = 1 << 16) {
  const store = new Map(Object.entries(seed));
  const files: BackupFiles & { store: typeof store; reads: number } = {
    store, reads: 0,
    open(file) {
      const text = store.get(file);
      if (text === undefined) throw new Error('missing file');
      let at = 0;
      files.reads++;
      return { async read() { if (at >= text.length) return null; const out = text.slice(at, at + chunk); at += chunk; return out; } };
    },
    create(file) {
      let text = '';
      return { async write(part) { text += part; }, async close() { store.set(file, text); } };
    },
  };
  return files;
}
const source = (text: string, chunk = 1 << 16): DumpSource => memoryFiles({ f: text }, chunk).open('f');
const rows = (db: TestSql) => db.db.query('SELECT id,name,qty,score,hex(data) AS data,updated_at,deleted_at FROM items ORDER BY id').all();

async function dumpOf(db: TestSql) {
  const files = memoryFiles();
  await exportReplica(db, files.create('dump'));
  return files.store.get('dump')!;
}

test('export is a versioned, sqlite3-importable dump of schema log, tables, rows, indexes, triggers and views', async () => {
  const db = await replica();
  db.db.exec("CREATE TABLE _core_private (k TEXT); INSERT INTO _core_private VALUES ('device state')");
  const dump = await dumpOf(db);
  expect(dump.startsWith(`${DUMP_HEADER}\nBEGIN TRANSACTION;\n`)).toBe(true);
  expect(dump.trimEnd().endsWith('COMMIT;')).toBe(true);
  expect(dump).not.toContain('device state');
  // The CLI's import path: sqlite3 executes the dump into a fresh life.db.
  const copy = new Database(':memory:');
  copy.exec(dump);
  expect(copy.query('SELECT id,name,qty,score,hex(data) AS data,updated_at,deleted_at FROM items ORDER BY id').all()).toEqual(rows(db));
  expect(copy.query("SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name").all())
    .toEqual([{ type: 'index', name: 'items_name' }, { type: 'trigger', name: 'items_updated_at' }, { type: 'view', name: 'live_items' }]);
  expect(copy.query('SELECT count(*) AS n FROM _schema_log').get()).toEqual({ n: 2 });
});

test('validation summarizes tables, live rows, newest revision and schema log, identically for any chunking', async () => {
  const db = await replica();
  const dump = await dumpOf(db);
  const summary = await validateBackup(source(dump));
  expect(summary).toEqual({ version: 1, rows: 2, newestUpdatedAt: T2, schemaEntries: 2,
    tables: [{ table: 'items', rows: 2, liveRows: 1, newestUpdatedAt: T2 }] });
  expect(summary).toEqual(await replicaSummary(db));
  for (const chunk of [1, 2, 3, 7, 64]) expect(await validateBackup(source(dump, chunk))).toEqual(summary);
});

test('restore replaces the replica in one step, keeps a recovery dump and resets device sync state', async () => {
  const backup = await dumpOf(await replica());
  const db = await replica([['old', 'Old row', null]]);
  db.db.exec("CREATE TABLE extra (id TEXT PRIMARY KEY, updated_at TEXT); INSERT INTO extra VALUES ('x', 'y')");
  db.db.exec(`INSERT INTO _core_sync VALUES ('items','${T1}','${T1}'); INSERT INTO _core_pending VALUES ('items','old','${T1}');
    INSERT INTO _core_rejected VALUES ('items','old','{}','[]'); INSERT INTO _core_coverage VALUES ('items','https://hub.test','s','${T1}',1);
    INSERT INTO _core_pull_progress VALUES ('items','','${T1}','old');
    INSERT INTO _core_state VALUES ('hub','https://hub.test'),('last_sync','${T1}'),('skipped_tables','[]')`);
  const before = await dumpOf(db);
  const files = memoryFiles({ backup });
  await expect(restoreReplica(db, files, { file: 'backup', recovery: 'recovery', confirm: 'nope' as 'replace' })).rejects.toThrow('replace');
  const result = await restoreReplica(db, files, { file: 'backup', recovery: 'recovery', confirm: 'replace' });
  expect(result.restored).toEqual(await validateBackup(source(backup)));
  expect(result.recovery.tables.map(t => [t.table, t.rows])).toEqual([['extra', 1], ['items', 1]]);
  expect(files.store.get('recovery')).toBe(before);
  expect(rows(db)).toEqual(rows(await replica()));
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name='extra'").all()).toEqual([]);
  expect(db.db.query("SELECT type,name FROM sqlite_master WHERE name IN ('items_name','items_updated_at','live_items') ORDER BY name").all().length).toBe(3);
  for (const table of ['_core_sync', '_core_pending', '_core_rejected', '_core_coverage', '_core_pull_progress']) {
    expect(db.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(db.db.query('SELECT key,value FROM _core_state ORDER BY key').all())
    .toEqual([{ key: 'coverage_phase', value: 'refreshing' }, { key: 'hub', value: 'https://hub.test' }]);
  // Undo is the same operation with the recovery dump.
  await restoreReplica(db, files, { file: 'recovery', recovery: 'recovery-2', confirm: 'replace' });
  expect(await dumpOf(db)).toBe(before);
});

test('an interrupted restore leaves the old replica intact', async () => {
  const backup = await dumpOf(await replica());
  const db = await replica([['old', 'Old row', null]]);
  const before = await dumpOf(db);
  const files = memoryFiles({ backup });
  const chunked = memoryFiles({ backup }, 300);
  files.open = (file) => {
    if (files.reads++ < 1) return chunked.open(file);
    const reader = chunked.open(file);
    let served = 0;
    return { async read() { if (++served > 3) throw new Error('disk vanished'); return reader.read(); } };
  };
  await expect(restoreReplica(db, files, { file: 'backup', recovery: 'recovery', confirm: 'replace' })).rejects.toBeInstanceOf(BackupInvalid);
  expect(await dumpOf(db)).toBe(before);
  // A backup that changes between validation and replacement is refused too.
  const swapped = memoryFiles({ backup });
  let opened = 0;
  swapped.open = (file) => memoryFiles({ [file]: opened++ ? backup.replace("'Bee'", "'Bumblebee'") : backup }).open(file);
  await expect(restoreReplica(db, swapped, { file: 'backup', recovery: 'recovery', confirm: 'replace' })).rejects.toThrow('changed');
  expect(await dumpOf(db)).toBe(before);
});

test('D1 export dumps validate and restore with exact values', async () => {
  const d1 = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, ddl TEXT NOT NULL);
INSERT INTO "_schema_log" ("id","applied_at","ddl") VALUES(1,'${T0}','${ITEMS}');
${ITEMS};
INSERT INTO "items" ("id","name","qty","score","data","created_at","updated_at","deleted_at","hub_at") VALUES('a',replace(replace('it''s\\r\\nhere','\\r',char(13)),'\\n',char(10)),-5,1e+300,X'00ff',NULL,'${T1}',NULL,NULL);
CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
INSERT INTO "_cf_KV" ("key","value") VALUES('k',X'01');
CREATE TABLE _governance_x (id TEXT);
INSERT INTO "_governance_x" ("id") VALUES('private');
CREATE INDEX items_name ON items(name);
${TRIGGER};
`;
  const summary = await validateBackup(source(d1, 5));
  expect(summary.tables).toEqual([{ table: 'items', rows: 1, liveRows: 1, newestUpdatedAt: T1 }]);
  const db = await replica();
  await restoreReplica(db, memoryFiles({ d1 }), { file: 'd1', recovery: 'r', confirm: 'replace' });
  expect(db.db.query('SELECT name,qty,score,hex(data) AS data FROM items').all()).toEqual([{ name: "it's\r\nhere", qty: -5, score: 1e300, data: '00FF' }]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE '\\_core%' ESCAPE '\\' ORDER BY name").all())
    .toEqual([{ name: '_schema_log' }, { name: '_sync_state' }]);
});

test("Python's iterdump of a CLI database, search cache included, restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-dump-'));
  try {
    const path = join(dir, 'life.db');
    const source = await replica();
    source.db.exec("CREATE VIRTUAL TABLE _core_search_fts USING fts5(body); INSERT INTO _core_search_fts VALUES ('cached')");
    source.db.exec(`VACUUM INTO '${path}'`);
    const dump = Bun.spawnSync(['python3', '-c', 'import sqlite3,sys; print("\\n".join(sqlite3.connect(sys.argv[1]).iterdump()))', path]);
    expect(dump.exitCode).toBe(0);
    const text = dump.stdout.toString();
    expect(text).toContain('INSERT INTO sqlite_master');
    const db = new TestSql();
    await initCore(db);
    await restoreReplica(db, memoryFiles({ text }), { file: 'text', recovery: 'r', confirm: 'replace' });
    expect(rows(db)).toEqual(rows(source));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt, foreign and wrong-version dumps are refused with a reason', async () => {
  const good = await dumpOf(await replica());
  const cases: [string, string][] = [
    ['', 'empty'],
    [good.slice(0, good.indexOf("'Bee'") + 3), 'ends inside a quoted value'],
    [good.slice(0, good.indexOf("'Bee'") + 6), 'middle of a statement'],
    [good.replace(/COMMIT;\n$/, ''), 'COMMIT'],
    [good + 'INSERT INTO items(id) VALUES (\'late\');\n', 'after its final COMMIT'],
    [good.replace('BEGIN TRANSACTION;', 'BEGIN TRANSACTION;\nDROP TABLE items;'), 'unsupported statement'],
    [good.replace("'Bee'", 'randomblob(4)'), 'unsupported value'],
    [good.replace('INSERT INTO "items"', 'INSERT INTO "nope"'), 'undeclared table'],
    [good.replace(/("updated_at"),/, '"bogus",'), 'unknown columns'],
    [good.replace(`${DUMP_HEADER}`, '-- life-data-dump: 2'), 'dump format 2'],
    [good.replace('applied_at TEXT', 'applied TEXT'), 'unsupported schema version'],
    [good.replace(/CREATE TABLE _schema_log[^;]*;\n(INSERT INTO "_schema_log"[^\n]*\n)*/, ''), 'no _schema_log'],
    [good.replace('BEGIN TRANSACTION;', "BEGIN TRANSACTION;\nCREATE VIRTUAL TABLE notes USING fts5(body);"), 'virtual table'],
  ];
  for (const [text, reason] of cases) {
    const error = await validateBackup(source(text, 97)).catch(e => e);
    expect(error).toBeInstanceOf(BackupInvalid);
    expect(String(error.message)).toContain(reason);
  }
  // Host readers own gzip; a damaged stream surfaces as an unreadable backup.
  const gz = gzipSync(good);
  gz[gz.length - 6]! ^= 0xff;
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  const error = await validateBackup({ async read() { const r = await stream.read(); return r.done ? null : r.value; } }).catch(e => e);
  expect(error).toBeInstanceOf(BackupInvalid);
  expect(error.message).toContain('could not be read');
});

test('preview compares the backup with the live replica; CLI-synced files are refused', async () => {
  const db = await replica([['old', 'Old row', null]]);
  const preview = await previewRestore(db, source(await dumpOf(await replica())));
  expect(preview.backup.tables).toEqual([{ table: 'items', rows: 2, liveRows: 1, newestUpdatedAt: T2 }]);
  expect(preview.current.tables).toEqual([{ table: 'items', rows: 1, liveRows: 1, newestUpdatedAt: T2 }]);
  db.db.exec("INSERT INTO _sync_state VALUES ('last_push','x')");
  await expect(previewRestore(db, source(await dumpOf(await replica())))).rejects.toThrow('Life CLI');
  await expect(restoreReplica(db, memoryFiles({ f: 'x' }), { file: 'f', recovery: 'r', confirm: 'replace' })).rejects.toThrow('Life CLI');
});

test('handlers clear undo after a restore and validate hub backup listings', async () => {
  const db = await replica();
  for (const ddl of schema.slice(1)) db.db.exec(ddl);
  db.db.exec("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text')");
  const files = memoryFiles({ backup: await dumpOf(db) });
  const handlers = createCoreHandlers(db, () => { throw new Error('offline'); }, 'test', null, files);
  await handlers.write({ table: 'items', patch: { id: 'a', name: 'Edited' }, expectedUpdatedAt: T2 });
  expect((await handlers.undoStatus({})).action).not.toBeNull();
  await handlers.restoreReplica({ file: 'backup', recovery: 'r', confirm: 'replace' });
  expect((await handlers.undoStatus({})).action).toBeNull();
  await expect(Promise.resolve().then(() => createCoreHandlers(db, () => { throw new Error(); }).validateBackup({ file: 'x' }))).rejects.toThrow('cannot open backup files');

  const reply = (data: unknown) => ({ endpoint: 'https://hub.test', post: async () => ({ data }), get: async () => ({ data }) });
  const backup = { key: 'daily/life-2026-10-08T09-10-00.sql.gz', taken_at: '2026-10-08T09:12:00.000Z', bytes: 12, sha256: null };
  expect(await listHubBackups(reply({ backups: [backup] }))).toEqual({ backups: [backup] });
  for (const bad of [{}, { backups: [{ ...backup, key: '../auth-x.sql.gz' }] }, { backups: [{ ...backup, sha256: 'xyz' }] }]) {
    await expect(listHubBackups(reply(bad))).rejects.toThrow('invalid hub backups response');
  }
});

test('restores row counts that fill whole insert batches exactly', async () => {
  const lines = ['CREATE TABLE _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, ddl TEXT NOT NULL);', 'CREATE TABLE t (id TEXT PRIMARY KEY, updated_at TEXT);'];
  for (let i = 0; i < 400; i++) lines.push(`INSERT INTO "t" ("id","updated_at") VALUES('${i}','${T0}');`);
  const db = new TestSql();
  await initCore(db);
  await restoreReplica(db, memoryFiles({ d: lines.join('\n') + '\n' }), { file: 'd', recovery: 'r', confirm: 'replace' });
  expect(db.db.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 400 });
});
