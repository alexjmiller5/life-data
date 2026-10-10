import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as core from '../src/index.ts';
import { schema, setup, TestSql, T0, T1, T2 } from './support.ts';

const databases: Database[] = [], directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});
async function local(file = false) {
  const db = new TestSql();
  let path = ':memory:';
  if (file) {
    const dir = mkdtempSync(join(tmpdir(), 'core-search-')); directories.push(dir);
    path = join(dir, 'fixture.sqlite'); db.db.close(); db.db = new Database(path);
    db.db.exec('PRAGMA journal_mode=WAL');
  }
  databases.push(db.db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('ALTER TABLE items ADD COLUMN body TEXT');
  await db.run('ALTER TABLE items ADD COLUMN private_text TEXT');
  await db.run('CREATE TABLE catalog_tables (id TEXT PRIMARY KEY, display TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('items','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('name','items','name','text'),('body','items','body','markdown'),('qty','items','qty','int')");
  await db.run('INSERT INTO items(id,name,body,qty,private_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ['a', 'Café field guide', '# Offline\n\n**Searching** with [links](https://example.test) and `code`.', 42, 'invisible', T0, T0]);
  return { db, path };
}
async function search(db: core.SqlDriver, args: { text: string; table?: string; limit?: number; offset?: number }) {
  return core.search(db, args);
}
async function ids(db: core.SqlDriver, text: string) { return (await search(db, { text })).map(r => r.id); }

test('mixed calendar values remain searchable at their stored precision', async () => {
  const { db } = await local();
  await db.run("UPDATE catalog_properties SET type='date_or_datetime' WHERE col='body'");
  await db.run("UPDATE items SET body='2032-02-29' WHERE id='a'");
  expect(await ids(db, '2032')).toEqual(['a']);
});

test('FTS searches raw Markdown and catalog text with accent folding and literal prefixes', async () => {
  const { db } = await local();
  expect(await ids(db, 'cafe off')).toEqual(['a']);
  expect(await ids(db, 'search')).toEqual(['a']);
  expect(await ids(db, 'arching')).toEqual([]); // word prefix, not substring
  expect(await ids(db, 'code')).toEqual(['a']);
  expect(await ids(db, 'invisible')).toEqual([]);
  expect(await ids(db, '42')).toEqual([]);
  expect(await search(db, { text: 'offline' })).toMatchObject([{ table: 'items', id: 'a', label: 'Café field guide' }]);
  expect((await search(db, { text: 'offline' }))[0].excerpt).toContain('Offline');
  expect((await db.all("SELECT sql FROM sqlite_master WHERE name='_core_search_fts'"))[0].sql).toContain('fts5');
});

test('read-only system table matches follow user records regardless of relevance', async () => {
  const { db } = await local();
  await db.run("INSERT INTO catalog_tables(id) VALUES ('history'),('audit')");
  await db.run("ALTER TABLE catalog_tables ADD COLUMN kind TEXT");
  await db.run("UPDATE catalog_tables SET kind='system' WHERE id='audit'");
  await db.run('CREATE TABLE audit (id TEXT PRIMARY KEY, note TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('h.old','history','old','text'),('h.new','history','new','text'),('a.note','audit','note','text')");
  // Each system row repeats the term, so plain relevance would rank it first.
  await db.run("INSERT INTO history(id,tbl,row_id,col,old,new) VALUES ('h1','items','a','name','Field guide field','Field guide field field')");
  await db.run("INSERT INTO audit(id,note) VALUES ('s1','field field field field')");
  const hits = await search(db, { text: 'field' });
  expect(hits[0]?.table).toBe('items');
  expect(hits.slice(1).map(h => h.table).sort()).toEqual(['audit', 'history']);
  expect((await search(db, { text: 'field', table: 'history' })).map(h => h.id)).toEqual(['h1']);
});

test('MATCH operators, punctuation and SQL-shaped input are literal and bounded', async () => {
  const { db } = await local();
  await db.run("INSERT INTO items(id,name,body) VALUES ('b','quoted','alpha OR beta')");
  expect(await ids(db, 'alpha OR beta')).toEqual(['b']);
  expect(await ids(db, 'alpha OR missing')).toEqual([]);
  for (const text of ['', '   ', '***', '"', '%_\\', "'); DROP TABLE items; --"]) {
    expect(await ids(db, text)).toEqual([]);
  }
  expect(await ids(db, '"alpha"')).toEqual(['b']);
  await expect(search(db, { text: 'a'.repeat(4097) })).rejects.toThrow(/search/i);
  expect((await db.all('SELECT count(*) AS n FROM items'))[0].n).toBe(2);
});

test('table search uses FTS before filtering, sorting and paging; contains stays substring based', async () => {
  const { db } = await local();
  for (let i = 0; i < 5; i++) await db.run('INSERT INTO items(id,name,qty) VALUES (?,?,?)', [`b${i}`, 'Searching', i]);
  const rows = await core.readRows(db, { table: 'items', search: 'search', filters: [{ column: 'qty', op: 'gte', value: 2 }], sort: [{ column: 'qty', direction: 'desc' }], limit: 2, offset: 1 });
  expect(rows.map(r => r.record.id)).toEqual(['b4', 'b3']);
  expect((await core.readRows(db, { table: 'items', search: 'arching' }))).toEqual([]);
  expect((await core.readRows(db, { table: 'items', filters: [{ column: 'name', op: 'contains', value: 'arching' }] })).map(r => r.record.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
});

test('durable triggers capture external edits without timestamp movement, rollback, IDs and hard deletes', async () => {
  const { db, path } = await local(true);
  await ids(db, 'offline');
  const external = new Database(path); databases.push(external);
  external.exec("UPDATE items SET body='external durable term' WHERE id='a'");
  external.exec("BEGIN; UPDATE items SET body='rolledback'; ROLLBACK");
  const reopened = new TestSql(); reopened.db.close(); reopened.db = new Database(path); databases.push(reopened.db);
  expect(await ids(reopened, 'durable')).toEqual(['a']);
  expect(await ids(reopened, 'offline')).toEqual([]);
  expect(await ids(reopened, 'rolledback')).toEqual([]);
  external.exec("UPDATE items SET id='renamed' WHERE id='a'");
  expect(await ids(reopened, 'durable')).toEqual(['renamed']);
  external.exec("DELETE FROM items WHERE id='renamed'");
  expect(await ids(reopened, 'durable')).toEqual([]);
});

test('REPLACE on a secondary unique key removes its silent delete victim from the index', async () => {
  const { db } = await local();
  await db.run('CREATE UNIQUE INDEX item_name_unique ON items(name)');
  await ids(db, 'offline');
  await db.run("INSERT OR REPLACE INTO items(id,name,body) VALUES ('replacement','Café field guide','successor')");
  expect(await ids(db, 'offline')).toEqual([]);
  expect(await ids(db, 'successor')).toEqual(['replacement']);
  expect((await db.all('SELECT count(*) AS n FROM _core_search_fts'))[0].n).toBe(1);
});

test('core writes, tombstones and restores keep FTS current while rejected writes leave it untouched', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await core.writeRow(db, 'items', { id: 'a', body: 'approved revision' }, { now: () => new Date(T1) });
  expect(await ids(db, 'approved')).toEqual(['a']);
  await expect(core.writeRow(db, 'items', { id: 'a', body: 'rejected revision', qty: 'bad' })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await ids(db, 'rejected')).toEqual([]);
  await core.writeRow(db, 'items', { id: 'a', deleted_at: true });
  expect(await ids(db, 'approved')).toEqual([]);
  expect((await core.readRows(db, { table: 'items', search: 'approved', trash: true })).map(r => r.record.id)).toEqual(['a']);
  await core.writeRow(db, 'items', { id: 'a', deleted_at: null });
  expect(await ids(db, 'approved')).toEqual(['a']);
});

test('index reconciliation follows catalog removal, column rename and table drop', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run("UPDATE catalog_properties SET deleted_at=? WHERE col='body'", [T1]);
  expect(await ids(db, 'offline')).toEqual([]);
  await db.run('ALTER TABLE items RENAME COLUMN body TO content');
  await db.run("UPDATE catalog_properties SET deleted_at=NULL,col='content' WHERE id='body'");
  expect(await ids(db, 'offline')).toEqual(['a']);
  await db.run('DROP TABLE items');
  expect(await ids(db, 'offline')).toEqual([]);
  expect((await db.all('SELECT count(*) AS n FROM _core_search_fts'))[0].n).toBe(0);
});

test('a failed drain rolls back index edits and retains dirty revisions for recovery', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run("UPDATE items SET body='recoverable' WHERE id='a'");
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    const changed = await run(sql, params);
    if (/DELETE FROM _core_search_dirty/.test(sql)) throw new Error('injected disk failure');
    return changed;
  };
  await expect(ids(db, 'recoverable')).rejects.toThrow('injected disk failure');
  db.run = run;
  expect(await db.all('SELECT row_id FROM _core_search_dirty')).toEqual([{ row_id: 'a' }]);
  expect(await ids(db, 'recoverable')).toEqual(['a']);
  expect(await ids(db, 'offline')).toEqual([]);
});

test('Markdown excerpts normalize formatting while raw URLs, code and table text remain searchable', async () => {
  const { db } = await local();
  await db.run('UPDATE items SET body=?', ['# Heading\n- **bold** [label](https://example.test/destination)\n`codeword`\n| column | value |']);
  const [hit] = await search(db, { text: 'heading' });
  expect(hit.excerpt).toContain('Heading');
  expect(hit.excerpt).toContain('bold label (https://example.test/destination)');
  expect(hit.excerpt).not.toContain('**');
  expect(hit.excerpt).not.toContain('# ');
  expect(hit.excerpt).toContain('codeword');
  for (const text of ['destination', 'codeword', 'column', 'value']) expect(await ids(db, text)).toEqual(['a']);
  await core.writeRow(db, 'items', { id: 'a', body: '## Replacement **heading**' });
  expect((await search(db, { text: 'replacement' }))[0].excerpt).toBe('Replacement heading\nCafé field guide');
});

test('excerpt cleanup preserves formatting characters inside code and link destinations', async () => {
  const { db } = await local();
  await db.run('UPDATE items SET body=?', ['**Heading** `__literal__` [link](https://example.test/__file__)']);
  const [hit] = await search(db, { text: 'heading' });
  expect(hit.excerpt).toContain('Heading __literal__ link (https://example.test/__file__)');
});

test('table rename reconciles SQLite-rewritten queue triggers and purges the old identity', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run('ALTER TABLE items RENAME TO renamed');
  await db.run("UPDATE catalog_tables SET id='renamed' WHERE id='items'");
  await db.run("UPDATE catalog_properties SET tbl='renamed' WHERE tbl='items'");
  expect((await search(db, { text: 'offline' })).map(r => r.table)).toEqual(['renamed']);
  await core.writeRow(db, 'renamed', { id: 'a', body: 'after rename' });
  expect(await ids(db, 'after')).toEqual(['a']);
  expect(await db.all("SELECT tbl FROM _core_search_docs WHERE tbl='items'")).toEqual([]);
});

test('exact trigger recognition rejects a forged owned name and TEMP or arbitrary side effects', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run('DROP TRIGGER _core_search_items_update');
  await db.run("CREATE TRIGGER _core_search_items_update AFTER UPDATE ON items BEGIN DELETE FROM history; END");
  await expect(core.writeRow(db, 'items', { id: 'a', body: 'forged' })).rejects.toBeInstanceOf(core.ValidationError);
  await expect(ids(db, 'offline')).rejects.toThrow(/trigger/i);
  expect((await db.all('SELECT body FROM items'))[0].body).toContain('Offline');
});

test('an exact queue trigger in TEMP still cannot bypass the write trigger guard', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  const [trigger] = await db.all("SELECT sql FROM sqlite_master WHERE name='_core_search_items_update'");
  await db.run(String(trigger.sql).replace('CREATE TRIGGER', 'CREATE TEMP TRIGGER'));
  await expect(core.writeRow(db, 'items', { id: 'a', body: 'temporary' })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await ids(db, 'temporary')).toEqual([]);
});

test('missing triggers rebuild safely after unobserved changes, without scanning on clean searches', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run('DROP TRIGGER _core_search_items_update');
  await db.run("UPDATE items SET body='unobserved' WHERE id='a'");
  expect(await ids(db, 'unobserved')).toEqual(['a']);
  const statements: string[] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  db.run = async (sql, params) => { statements.push(sql); return run(sql, params); };
  expect(await ids(db, 'unobserved')).toEqual(['a']);
  expect(statements.some(sql => /\bFROM\s+"?items"?\b/i.test(sql))).toBe(false);
  expect(statements.some(sql => /^(INSERT|DELETE|UPDATE)\b/i.test(sql))).toBe(false);
  const query = core.compileView({ table: 'items', search: 'unobserved' }, (await core.readCatalog(db)).properties);
  const plan = await all('EXPLAIN QUERY PLAN ' + query.sql, query.params);
  expect(plan.some(r => /SEARCH _view_row USING INDEX.*\(id=\?\)/.test(String(r.detail)))).toBe(true);
});

test('upsert queue survives repeated OR ABORT/IGNORE/REPLACE writes and update replacement victims', async () => {
  const { db } = await local();
  await db.run('CREATE UNIQUE INDEX unique_qty ON items(qty)');
  await db.run("INSERT INTO items(id,name,body,qty) VALUES ('b','Second','victim',7)");
  await ids(db, 'offline');
  await db.run("UPDATE OR ABORT items SET body='first' WHERE id='a'");
  await db.run("UPDATE OR ABORT items SET body='second' WHERE id='a'");
  await db.run("UPDATE OR IGNORE items SET body='third' WHERE id='a'");
  await db.run("UPDATE OR REPLACE items SET qty=7,body='survivor' WHERE id='a'");
  expect(await ids(db, 'victim')).toEqual([]);
  expect(await ids(db, 'survivor')).toEqual(['a']);
  expect((await db.all('SELECT count(*) AS n FROM _core_search_fts'))[0].n).toBe(1);
});

test('drain and read hold one writer reservation; a later external revision survives to the next search', async () => {
  const { db, path } = await local(true);
  await ids(db, 'offline');
  const external = new Database(path); databases.push(external);
  const all = db.all.bind(db);
  let attempted = false;
  db.all = async (sql, params) => {
    if (sql.includes('bm25(')) {
      attempted = true;
      expect(() => external.exec("UPDATE items SET body='concurrent' WHERE id='a'")).toThrow(/locked/);
    }
    return all(sql, params);
  };
  expect(await ids(db, 'offline')).toEqual(['a']);
  expect(attempted).toBe(true);
  db.all = all;
  external.exec("UPDATE items SET body='concurrent' WHERE id='a'");
  expect(await ids(db, 'concurrent')).toEqual(['a']);
});

test('FTS capability failure is explicit and installs no queue triggers or partial state', async () => {
  const { db } = await local();
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    if (/USING fts5/.test(sql)) throw new Error('no such module: fts5');
    return run(sql, params);
  };
  await expect(core.assertSearchSupport(db)).rejects.toThrow(/FTS5.*unicode61/);
  await expect(ids(db, 'offline')).rejects.toThrow(/FTS5-enabled/);
  expect(await db.all("SELECT name FROM sqlite_master WHERE name GLOB '_core_search_*'")).toEqual([]);
});

test('real hub pulls update the index across replicas without syncing local search plumbing', async () => {
  const { db, remote, hub, requests } = setup();
  databases.push(db.db, remote.db);
  const ddl = 'CREATE TABLE catalog_tables (id TEXT PRIMARY KEY, display TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)';
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query("INSERT INTO catalog_tables(id,display,updated_at,hub_at) VALUES ('items','name',?,?)").run(T0, T1);
  remote.db.query("INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES ('name','items','name','text',?,?)").run(T0, T1);
  remote.db.query("INSERT INTO items(id,name,updated_at,hub_at) VALUES ('a','original',?,?)").run(T0, T1);
  await core.sync(db, hub);
  expect(await ids(db, 'original')).toEqual(['a']);
  remote.db.query("UPDATE items SET name='pulled replacement',updated_at=?,hub_at=?").run(T1, T2);
  await core.sync(db, hub);
  expect(await ids(db, 'original')).toEqual([]);
  expect(await ids(db, 'replacement')).toEqual(['a']);
  await core.writeRow(db, 'items', { id: 'a', name: 'sent edit' });
  await core.sync(db, hub);
  expect(await ids(db, 'sent')).toEqual(['a']);
  expect(requests.some(r => JSON.stringify(r.body).includes('_core_search_'))).toBe(false);
  expect(await db.all("SELECT ddl FROM _schema_log WHERE ddl LIKE '%_core_search_%'")).toEqual([]);
});

test.each(['_core_search_fts', '_core_search_docs', '_core_search_dirty', '_core_search_state'])(
  'a lost %s cache component rebuilds without losing unchanged rows', async name => {
    const { db } = await local();
    await ids(db, 'offline');
    await db.run(`DROP TABLE ${name}`);
    expect(await ids(db, 'offline')).toEqual(['a']);
    await db.run("UPDATE items SET body='after recovery'");
    expect(await ids(db, 'recovery')).toEqual(['a']);
  },
);

test('nonbinary primary keys do not retain a REPLACE victim under a different spelling', async () => {
  const { db } = await local();
  await db.run('CREATE TABLE folded (id TEXT PRIMARY KEY COLLATE NOCASE, body TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id) VALUES ('folded')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('folded.body','folded','body','text')");
  await db.run("INSERT INTO folded(id,body) VALUES ('lower','oldspelling')");
  expect(await ids(db, 'oldspelling')).toEqual(['lower']);
  await db.run("INSERT OR REPLACE INTO folded(id,body) VALUES ('LOWER','newspelling')");
  expect(await ids(db, 'oldspelling')).toEqual([]);
  expect(await ids(db, 'newspelling')).toEqual(['LOWER']);
});

test('NOCASE ID aliases across drain batches replace the actual row identity exactly once', async () => {
  const { db } = await local();
  await db.run('CREATE TABLE folded (id TEXT PRIMARY KEY COLLATE NOCASE, body TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id) VALUES ('folded')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('folded.body','folded','body','markdown')");
  const original = Array.from({ length: 101 }, (_, i) => `key${String(i).padStart(3, '0')}`);
  for (const id of original) await db.run('INSERT INTO folded(id,body) VALUES (?,?)', [id, 'needle']);
  expect((await search(db, { text: 'needle', limit: 200 })).map(r => r.id)).toEqual(original);
  await db.run('UPDATE folded SET id=upper(id)');
  expect((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0].n).toBe(202);
  const expected = original.map(id => id.toUpperCase());
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await search(db, { text: 'needle', limit: 200 })).map(r => r.id)).toEqual(expected);
    expect((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0].n).toBe(0);
    expect((await db.all("SELECT count(*) AS n FROM _core_search_docs WHERE tbl='folded'"))[0].n).toBe(101);
    expect((await db.all("SELECT count(*) AS n FROM _core_search_fts WHERE _core_search_fts MATCH 'needle'"))[0].n).toBe(101);
  }
  await db.run('UPDATE folded SET id=lower(id)');
  expect((await core.readRows(db, { table: 'folded', search: 'needle', limit: 200 })).map(r => r.record.id)).toEqual(original);
});

test('Python can edit the shared file while the UI is closed; the next open indexes its committed text', async () => {
  const { db, path } = await local(true);
  await ids(db, 'offline');
  const result = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("UPDATE items SET body='python same revision' WHERE id='a'")
    db.execute("INSERT INTO items(id,name,body) VALUES ('python','Python record','independent writer')")
`, path], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(await ids(db, 'revision')).toEqual(['a']);
  expect(await ids(db, 'independent')).toEqual(['python']);
});

test('global search pages tied scores deterministically and scopes duplicate IDs by table', async () => {
  const { db } = await local();
  await db.run('DELETE FROM items');
  for (let i = 0; i < 205; i++) await db.run('INSERT INTO items(id,name) VALUES (?,?)', [String(i).padStart(3, '0'), 'needle']);
  await db.run('CREATE TABLE other (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO other(id,name) VALUES ('000','needle')");
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('other','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('other.name','other','name','text')");
  expect(await search(db, { text: 'needle' })).toHaveLength(50);
  expect(await search(db, { text: 'needle', limit: 1000 })).toHaveLength(200);
  expect((await search(db, { text: 'needle', limit: 200, offset: 200 })).map(r => [r.table, r.id]))
    .toEqual([['items', '200'], ['items', '201'], ['items', '202'], ['items', '203'], ['items', '204'], ['other', '000']]);
  expect((await search(db, { text: 'needle', table: 'other' })).map(r => r.id)).toEqual(['000']);
});

test('a document containing a huge single token still returns a bounded excerpt', async () => {
  const { db } = await local();
  await db.run('UPDATE items SET body=?', ['longword' + 'x'.repeat(10_000)]);
  const hit = (await search(db, { text: 'longword' }))[0];
  expect(hit.excerpt).toContain('longword');
  expect(hit.excerpt.length).toBeLessThanOrEqual(512);
});

test('failure in a later drain batch rolls back earlier batches and preserves the whole queue', async () => {
  const { db } = await local();
  for (let i = 0; i < 204; i++) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [`b${i}`, 'Original', 'previous']);
  await ids(db, 'previous');
  await db.run("UPDATE items SET body='nextrevision'");
  const run = db.run.bind(db);
  let batches = 0;
  db.run = async (sql, params) => {
    const changes = await run(sql, params);
    if (sql.startsWith('DELETE FROM _core_search_dirty') && ++batches === 2) throw new Error('second batch failed');
    return changes;
  };
  await expect(ids(db, 'nextrevision')).rejects.toThrow('second batch failed');
  db.run = run;
  expect((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0].n).toBe(205);
  expect((await db.all("SELECT count(*) AS n FROM _core_search_fts WHERE _core_search_fts MATCH 'nextrevision'"))[0].n).toBe(0);
  expect(await search(db, { text: 'nextrevision', limit: 200 })).toHaveLength(200);
  expect(await search(db, { text: 'nextrevision', limit: 200, offset: 200 })).toHaveLength(5);
});

test.each([
  null, [], {}, { text: null }, { text: 3 }, { text: 'word', table: null },
  { text: 'word', table: 'missing' }, { text: 'word', sql: '1=1' },
  ...[0, -1, 1.5, NaN, Infinity, '4', null].map(limit => ({ text: 'word', limit })),
  ...[-1, 1.5, NaN, Infinity, '4', null].map(offset => ({ text: 'word', offset })),
  { text: Array(65).fill('word').join(' ') },
])('rejects malformed search arguments %j', async args => {
  const { db } = await local();
  await expect(core.search(db, args as core.SearchArgs)).rejects.toThrow();
});

test('draining dirty rows looks up index entries by identity instead of ranging over the table', async () => {
  const { db } = await local();
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [`r${i}`, 'Row', 'first']);
  await ids(db, 'first');
  await db.run("UPDATE items SET body='second'");
  const statements: [string, core.Value[]][] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  db.all = async (sql, params = []) => { statements.push([sql, params]); return all(sql, params); };
  db.run = async (sql, params = []) => { statements.push([sql, params]); return run(sql, params); };
  expect(await search(db, { text: 'second', limit: 200 })).toHaveLength(200);
  db.all = all; db.run = run;
  const plans: string[] = [];
  for (const [sql, params] of statements.filter(([sql]) => /_core_search_(docs|dirty)/.test(sql) && !/^CREATE|LIMIT 1$/.test(sql)))
    for (const row of await all('EXPLAIN QUERY PLAN ' + sql, params)) plans.push(`${row.detail}  <-  ${sql.slice(0, 80)}`);
  // A per-batch statement that reads every queued or indexed row of the table grows with the table.
  expect(plans.filter(p => /\bSCAN (d|_core_search_docs|_core_search_dirty)\b|\(tbl=\?\)  /.test(p))).toEqual([]);
});

test('a word matching more rows than the ranking bound ranks only the most recently indexed matches', async () => {
  const { db } = await local();
  // Indexed first and most relevant; ranking every match would put it on top.
  await db.run("INSERT INTO items(id,name,body) VALUES ('old','needle needle needle','needle needle needle')");
  await ids(db, 'needle');
  db.db.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO items(id,name) SELECT 'n'||i,'needle' FROM n").run(core.SEARCH_RANKED_MATCHES);
  const hits = await search(db, { text: 'needle', limit: 200 });
  expect(hits).toHaveLength(200);
  expect(hits.some(h => h.id === 'old')).toBe(false);
  expect(hits.every(h => h.excerpt === 'needle')).toBe(true);
  // At the bound nothing is dropped, and the most relevant match ranks first.
  await db.run("DELETE FROM items WHERE id='n1'");
  expect((await search(db, { text: 'needle', limit: 1 }))[0]).toMatchObject({ id: 'old', excerpt: 'needle needle needle\nneedle needle needle' });
});

test('the ranking bound applies within the searched table and to live records only', async () => {
  const { db } = await local();
  await db.run("INSERT INTO items(id,name) VALUES ('mine','needle')");
  await db.run('CREATE TABLE other (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('other','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('other.name','other','name','text')");
  await ids(db, 'needle');
  db.db.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO other(id,name,deleted_at) SELECT 'o'||i,'needle','2026-01-01T00:00:00.000Z' FROM n").run(core.SEARCH_RANKED_MATCHES);
  expect((await search(db, { text: 'needle' })).map(h => h.id)).toEqual(['mine']);
  db.db.query("UPDATE other SET deleted_at=NULL").run();
  expect((await search(db, { text: 'needle', table: 'items' })).map(h => h.id)).toEqual(['mine']);
});

test('excerpts center the first matching word of long text and fold accents like the index', async () => {
  const { db } = await local();
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`);
  words[40] = 'Crème';
  await db.run("UPDATE items SET body=? WHERE id='a'", [words.join(' ')]);
  const [hit] = await search(db, { text: 'creme' });
  expect(hit.excerpt).toBe('...w29 w30 w31 w32 w33 w34 w35 w36 w37 w38 w39 Crème w41 w42 w43 w44 w45 w46 w47 w48 w49 w50 w51 w52...');
  words[40] = 'w40';
  words[5] = 'Crème';
  await db.run("UPDATE items SET body=? WHERE id='a'", [words.join(' ')]);
  expect((await search(db, { text: 'creme' }))[0].excerpt).toBe(`${words.slice(0, 24).join(' ')}...`);
});

test('an unchanged, fully indexed database searches without re-reading catalog properties or table schemas', async () => {
  const { db } = await local();
  expect(await ids(db, 'offline')).toEqual(['a']);
  const statements: string[] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  db.run = async (sql, params) => { statements.push(sql); return run(sql, params); };
  expect(await ids(db, 'offline')).toEqual(['a']);
  expect(statements.filter(sql => /SELECT \* FROM "catalog_(properties|rules)"|PRAGMA main\.table_info/.test(sql))).toEqual([]);
  expect(statements.length).toBeLessThan(20); // a full reconciliation is a few per table
  db.all = all; db.run = run;
  // Catalog, schema and row changes each still reach the index.
  await db.run("UPDATE catalog_properties SET type='text' WHERE col='qty'");
  expect(await ids(db, '42')).toEqual(['a']);
  await db.run('ALTER TABLE items ADD COLUMN subtitle TEXT');
  await db.run("UPDATE items SET subtitle='appendix' WHERE id='a'");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('subtitle','items','subtitle','text')");
  expect(await ids(db, 'appendix')).toEqual(['a']);
  await db.run("UPDATE items SET body='rewritten' WHERE id='a'");
  expect(await ids(db, 'rewritten')).toEqual(['a']);
});
