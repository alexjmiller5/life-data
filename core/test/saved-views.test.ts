import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as core from '../src/index.ts';
import fixture from '../schema/saved-views.json';
import { schema, setup, TestSql, T0, T1 } from './support.ts';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function local(provision = true) {
  const db = new TestSql(); databases.push(db.db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,kind,display) VALUES ('items','table','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text'),('items.qty','items','qty','int')");
  if (provision) {
    for (const ddl of fixture.ddl) await db.run(ddl);
    const table = fixture.table;
    await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)', [table.id, table.kind, table.display]);
    for (const p of fixture.properties) {
      const keys = Object.keys(p);
      await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(p) as core.Value[]);
    }
  }
  return db;
}
const definition: core.SavedViewDefinition = { version: 1, columns: ['name','qty'], filters: [{ column: 'qty', op: 'gte', value: 2 }], sort: [{ column: 'name', direction: 'asc' }], widths: { name: 320 } };
async function list(db: core.SqlDriver, args: core.ListViewsArgs = { table: 'items' }) {
  return core.listViews(db, args);
}
async function save(db: core.SqlDriver, args: unknown) {
  return core.saveView(db, args as core.SaveViewArgs);
}
async function remove(db: core.SqlDriver, args: unknown) {
  return core.deleteView(db, args as core.DeleteViewArgs);
}
async function insert(db: TestSql, id: string, value: unknown, name = id) {
  await db.run('INSERT INTO views(id,name,tbl,definition,updated_at) VALUES (?,?,?,?,?)', [id,name,'items',typeof value === 'string' ? value : JSON.stringify(value),T0]);
}

test('version 2 grouped and relative definitions round-trip without persisting a calendar',async()=>{
  const db=await local();
  await db.run('ALTER TABLE items ADD COLUMN due TEXT');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.due','items','due','date')");
  const definition:core.SavedViewDefinition={version:2,timeZone:'America/New_York',groups:[{match:'any',filters:[{column:'qty',op:'gte',value:3},{column:'qty',op:'empty'}]}],filters:[{column:'due',op:'lte',relative:'today'}]};
  const saved=await save(db,{table:'items',name:'Daily',definition});
  expect(saved.unavailable).toBeNull();expect(saved.definition).toEqual(definition);
  const reopened=(await list(db)).views[0];expect(reopened.definition).toEqual(definition);
  expect(reopened.view).toEqual({table:'items',groups:definition.groups,filters:definition.filters});
  await expect(core.readRows(db,reopened.view!)).rejects.toThrow(/calendar/i);
  const before=await db.all('SELECT * FROM views');
  for(const bad of [{...definition,calendar:{today:'2026-03-08'}},{...definition,timeZone:undefined},{...definition,version:1}]){
    await expect(save(db,{table:'items',name:'Invalid',definition:bad})).rejects.toThrow();
  }
  expect(await db.all('SELECT * FROM views')).toEqual(before);
});

test('version 2 query extensions remain unavailable to version 1 definitions',async()=>{
  const db=await local();
  await insert(db,'old',{version:1});await insert(db,'future',{version:3});
  await insert(db,'bad',{version:1,groups:[{match:'any',filters:[{column:'qty',op:'empty'}]}]});
  const result=await list(db);
  expect(result.views.find(v=>v.id==='old')?.unavailable).toBeNull();
  for(const id of ['future','bad'])expect(result.views.find(v=>v.id===id)?.unavailable).toBeTruthy();
});

test.each(['canonical', 'ddl', 'metadata'])('a standalone browser bundle recognizes its packaged saved-view manifest: %s', async variant => {
  const temp = await mkdtemp(join(tmpdir(), 'core-manifest-'));
  try {
    const pack = Bun.spawn(['bun', 'pm', 'pack', '--ignore-scripts', '--filename', join(temp, 'core.tgz')], {
      cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
    });
    expect(await pack.exited).toBe(0);
    const modules = join(temp, 'node_modules');
    const pkg = join(modules, 'life-core');
    await mkdir(pkg, { recursive: true });
    const unpack = Bun.spawn(['tar', '-xzf', join(temp, 'core.tgz'), '-C', pkg, '--strip-components=1'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await unpack.exited).toBe(0);
    const entry = join(temp, 'consumer.ts');
    await writeFile(entry, `export { listViews } from 'life-core';\nexport { default as manifest } from 'life-core/schema/saved-views.json';\n`);
    if (variant !== 'canonical') {
      // Change only the packaged manifest. A second DDL/metadata literal in
      // production would reject the corresponding schema seeded below.
      const path = join(pkg, 'schema/saved-views.json');
      const manifest: typeof fixture = JSON.parse(await readFile(path, 'utf8'));
      if (variant === 'ddl') manifest.ddl[0] = manifest.ddl[0].replace('"name" TEXT', '"name" TEXT COLLATE BINARY');
      else {
        manifest.table.display = 'tbl';
        manifest.properties[0].type = 'markdown';
        manifest.properties[2].source_ref = 'saved-views/fixture';
      }
      await writeFile(path, JSON.stringify(manifest));
    }
    const build = await Bun.build({ entrypoints: [entry], outdir: join(temp, 'bundle'), target: 'browser', format: 'esm' });
    expect(build.logs).toEqual([]);
    expect(build.success).toBe(true);
    await rm(modules, { recursive: true });
    const bundled: { manifest: typeof fixture; listViews: typeof core.listViews } = await import(join(temp, 'bundle/consumer.js'));
    const db = await local(false);
    for (const ddl of bundled.manifest.ddl) await db.run(ddl);
    const table = bundled.manifest.table;
    await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)', [table.id, table.kind, table.display]);
    for (const p of bundled.manifest.properties) {
      const keys = Object.keys(p);
      await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(p) as core.Value[]);
    }
    await insert(db, 'shared', { version: 1 });
    const result = await bundled.listViews(db, { table: 'items' });
    expect(result.unavailable).toBeNull();
    expect(result.views.map(v => v.id)).toEqual(['shared']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('property ordering is presentation metadata, not a storage identity requirement', async () => {
  const db = await local();
  await db.run("UPDATE catalog_properties SET sort=100-sort WHERE tbl='views'");
  const saved = await save(db, { table: 'items', name: 'Example', definition });
  expect((await list(db)).views.map(v => v.id)).toEqual([saved.id]);
});

test('missing saved-view storage is unavailable without provisioning or logging local DDL', async () => {
  const db = await local(false);
  const before = await db.all('SELECT name,sql FROM sqlite_master ORDER BY name');
  const result = await list(db);
  expect(result.views).toEqual([]);
  expect(result.unavailable).toMatch(/setup|provision/i);
  await expect(save(db, { table: 'items', name: 'Example', definition })).rejects.toThrow(/setup|provision/i);
  expect(await db.all('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(before);
});

test('an agent-created view returns portable core query state with no persisted default selection', async () => {
  const db = await local();
  await insert(db, 'agent-view', definition, 'By quantity');
  const result = await list(db);
  expect(result.unavailable).toBeNull();
  expect(result.views).toEqual([{
    id: 'agent-view', name: 'By quantity', tbl: 'items', updated_at: T0, deleted_at: null,
    definition, view: { table: 'items', columns: ['name','qty'], filters: [{ column: 'qty', op: 'gte', value: 2 }], sort: [{ column: 'name', direction: 'asc' }] }, unavailable: null,
  }]);
  expect((await db.all('SELECT count(*) AS n FROM views'))[0].n).toBe(1);
});

test('save/edit uses core revisions, history and pending markers and rejects stale edits atomically', async () => {
  const db = await local();
  const created = await save(db, { table: 'items', name: 'Example', definition });
  expect(created.id).toMatch(/^[a-f0-9]{32}$/);
  expect(created.view?.table).toBe('items');
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  const edited = await save(db, { id: created.id, table: 'items', name: 'Renamed', definition, expectedUpdatedAt: created.updated_at });
  expect(edited.updated_at! > created.updated_at!).toBe(true);
  expect(await db.all("SELECT col,old,new FROM history WHERE tbl='views'")).toEqual([{ col: 'name', old: 'Example', new: 'Renamed' }]);
  await expect(save(db, { id: created.id, table: 'items', name: 'Stale', definition, expectedUpdatedAt: created.updated_at })).rejects.toBeInstanceOf(core.ValidationError);
  expect((await list(db)).views[0].name).toBe('Renamed');
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
});

test('malformed JSON, unknown versions and removed columns are unavailable per view without list failure', async () => {
  const db = await local();
  await insert(db, 'a-good', { version: 1 });
  await insert(db, 'b-json', '{broken');
  await insert(db, 'c-version', { version: 2, future: true });
  await insert(db, 'd-column', { version: 1, columns: ['removed'] });
  await insert(db, 'e-search', { version: 1, search: 'x'.repeat(4097) });
  const before = await db.all('SELECT * FROM views ORDER BY id');
  const result = await list(db);
  expect(result.unavailable).toBeNull();
  expect(result.views).toHaveLength(5);
  expect(result.views[0].view).toEqual({ table: 'items' });
  for (const row of result.views.slice(1)) {
    expect(row.unavailable).toBeTruthy();
    expect(row.view).toBeNull();
  }
  expect(await db.all('SELECT * FROM views ORDER BY id')).toEqual(before);
});

test('delete permits unknown definitions where core permits it and retains revision/history semantics', async () => {
  const db = await local();
  await insert(db, 'future', { version: 42 });
  const deleted = await remove(db, { id: 'future', expectedUpdatedAt: T0 });
  expect(deleted.deleted_at).toBe(deleted.updated_at);
  expect((await list(db)).views).toEqual([]);
  expect((await core.listViews(db, { table: 'items', trash: true })).views[0].id).toBe('future');
  expect((await db.all("SELECT col FROM history WHERE tbl='views'"))).toEqual([{ col: 'deleted_at' }]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  await expect(remove(db, { id: 'future', expectedUpdatedAt: T0 })).rejects.toBeInstanceOf(core.ValidationError);
});

test.each([
  "UPDATE catalog_properties SET source_ref=NULL WHERE id='views.definition'",
  "UPDATE catalog_properties SET source='foreign' WHERE id='views.definition'",
  "UPDATE catalog_properties SET type='text' WHERE id='views.definition'",
  "UPDATE catalog_properties SET ref_table='items' WHERE id='views.tbl'",
  "UPDATE catalog_properties SET required=0 WHERE id='views.name'",
  "UPDATE catalog_properties SET col='other' WHERE id='views.name'",
  "UPDATE catalog_properties SET id='foreign.name' WHERE id='views.name'",
  "INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('views.extra','views','extra','text')",
  "UPDATE catalog_properties SET deleted_at='2025-01-01T00:00:00.000Z' WHERE id='views.name'",
  "UPDATE catalog_tables SET kind='system' WHERE id='views'",
  "UPDATE catalog_tables SET display='tbl' WHERE id='views'",
  "DROP TRIGGER views_updated_at",
  "ALTER TABLE views ADD COLUMN owner_id TEXT",
])('schema collisions are read-only setup errors: %s', async sql => {
  const db = await local();
  await insert(db, 'keep', { version: 1 });
  await db.run(sql);
  const before = await db.all('SELECT * FROM views');
  expect((await list(db)).unavailable).toBeTruthy();
  await expect(save(db, { table: 'items', name: 'New', definition })).rejects.toThrow();
  await expect(remove(db, { id: 'keep' })).rejects.toThrow();
  expect(await db.all('SELECT * FROM views')).toEqual(before);
});

test.each([
  { version: 3 }, { version: 1, table: 'elsewhere' }, { version: 1, limit: 10 }, { version: 1, offset: 4 },
  { version: 1, owner: 'private' }, { version: 1, columns: [] }, { version: 1, columns: ['missing'] },
  { version: 1, columns: ['name', 'name'] },
  { version: 1, filters: [{ column: 'qty', op: 'sql', value: '1=1' }] },
  { version: 1, widths: { name: 0 } }, { version: 1, widths: { name: Infinity } }, { version: 1, widths: { missing: 40 } },
])('invalid definitions never write a row, history or pending edit: %j', async invalid => {
  const db = await local();
  await expect(save(db, { table: 'items', name: 'Example', definition: invalid })).rejects.toThrow();
  expect(await db.all('SELECT * FROM views')).toEqual([]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('removed physical columns and missing target tables disable a view even before catalog repair', async () => {
  const db = await local();
  await insert(db, 'a', definition);
  await db.run('ALTER TABLE items DROP COLUMN qty');
  expect((await list(db)).views[0].unavailable).toBeTruthy();
  await db.run("UPDATE catalog_tables SET deleted_at=? WHERE id='items'", [T1]);
  expect((await list(db)).views[0].view).toBeNull();
});

test('failed history or pending writes roll back the saved definition and revision together', async () => {
  const db = await local();
  await insert(db, 'existing', { version: 1 });
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    if (sql.includes('INTO _core_pending')) throw new Error('disk failure');
    return run(sql, params);
  };
  await expect(save(db, { id: 'existing', table: 'items', name: 'Changed', definition, expectedUpdatedAt: T0 })).rejects.toThrow();
  db.run = run;
  expect((await list(db)).views[0]).toMatchObject({ name: 'existing', updated_at: T0, definition: { version: 1 } });
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('saved columns are explicit projection; callers fetch unprojected rows for identity and editing', async () => {
  const db = await local();
  await db.run('INSERT INTO items(id,name,qty,updated_at) VALUES (?,?,?,?)', ['item','Example',3,T0]);
  const saved = await save(db, { table: 'items', name: 'Narrow', definition: { version: 1, columns: ['name'] } });
  expect((await core.readRows(db, saved.view!))[0].record).toEqual({ name: 'Example' });
  const { columns: _columns, ...full } = saved.view!;
  expect((await core.readRows(db, full))[0].record).toMatchObject({ id: 'item', name: 'Example', qty: 3, updated_at: T0 });
});

test('saved-view operations preserve normal write restrictions', async () => {
  const db = await local();
  await db.run("INSERT INTO catalog_rules(id,tbl,kind,enforce) VALUES ('rule','views','invariant',1)");
  await expect(save(db, { table: 'items', name: 'Restricted', definition })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await db.all('SELECT * FROM views')).toEqual([]);
});

test('arguments are snapshotted before the asynchronous transaction begins', async () => {
  const db = await local();
  const input = { table: 'items', name: 'Original', definition: { version: 1, columns: ['name'] } };
  const saving = save(db, input);
  input.name = 'Changed'; input.definition.columns.push('missing');
  expect(await saving).toMatchObject({ name: 'Original', definition: { version: 1, columns: ['name'] } });
});

test('editing an existing saved view requires its selected revision', async () => {
  const db = await local();
  await insert(db, 'existing', { version: 1 });
  await expect(save(db, { id: 'existing', table: 'items', name: 'Changed', definition })).rejects.toThrow(/expectedUpdatedAt/);
  expect((await list(db)).views[0].name).toBe('existing');
});

test('delete requires a selected revision and missing or stale revisions change nothing', async () => {
  const db = await local();
  await insert(db, 'existing', { version: 1 });
  for (const args of [{ id: 'existing' }, { id: 'existing', expectedUpdatedAt: T1 }]) {
    await expect(remove(db, args)).rejects.toThrow();
    expect((await list(db)).views[0]).toMatchObject({ id: 'existing', updated_at: T0, deleted_at: null });
    expect(await db.all('SELECT * FROM history')).toEqual([]);
    expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  }
});

test('widths reject physically present but uncataloged fields; malformed views can still be deleted', async () => {
  const db = await local();
  await db.run('ALTER TABLE items ADD COLUMN hidden TEXT');
  await expect(save(db, { table: 'items', name: 'Invalid', definition: { version: 1, widths: { hidden: 400 } } })).rejects.toThrow();
  await insert(db, 'broken', '{broken');
  await db.run("UPDATE catalog_tables SET deleted_at=? WHERE id='items'", [T1]);
  const deleted = await remove(db, { id: 'broken', expectedUpdatedAt: T0 });
  expect(deleted.deleted_at).toBeTruthy();
  expect(deleted.unavailable).toBeTruthy();
});

test('every malformed definition stays per-view unavailable while driver failure aborts listing', async () => {
  const db = await local();
  const invalid = [null, [], { version: 1, sort: null }, { version: 1, filters: [null] }, { version: 1, columns: ['name','name'] }, { version: 1, widths: { removed: 50 } }];
  for (let i = 0; i < invalid.length; i++) await insert(db, String(i), invalid[i]);
  expect((await list(db)).views.every((v: core.SavedViewRecord) => v.unavailable && v.view === null)).toBe(true);
  await insert(db, 'good', { version: 1 });
  const all = db.all.bind(db);
  db.all = async (sql, params) => {
    if (sql.includes('table_info("items")')) throw new Error('disk failure');
    return all(sql, params);
  };
  await expect(list(db)).rejects.toThrow('disk failure');
});

test('shared views round-trip through the real hub with history, own receipts and no provisioning DDL', async () => {
  const { db, remote, hub, requests } = setup(); databases.push(db.db, remote.db);
  const ddl = [
    'ALTER TABLE catalog_properties ADD COLUMN source TEXT',
    'ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT',
    'CREATE TABLE catalog_tables (id TEXT PRIMARY KEY,kind TEXT,display TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
    ...fixture.ddl,
  ];
  for (const sql of ddl) {
    remote.db.exec(sql);
    remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, sql);
  }
  for (const table of [{ id: 'items', kind: 'table', display: 'name' }, fixture.table]) remote.db.query('INSERT INTO catalog_tables(id,kind,display,updated_at,hub_at) VALUES (?,?,?,?,?)').run(table.id,table.kind,table.display,T0,T1);
  for (const p of [...fixture.properties, { id: 'items.name', tbl: 'items', col: 'name', type: 'text' }]) {
    const row = { ...p, updated_at: T0, hub_at: T1 };
    const keys = Object.keys(row);
    remote.db.query(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  await core.sync(db, hub);
  const handlers = core.createCoreHandlers(db, () => { throw new Error('unused'); }, 'fixture');
  const created = await handlers.saveView({ table: 'items', name: 'Shared', definition: { version: 1, columns: ['name'] } });
  expect((await handlers.status({})).pendingUiEdits).toBe(1);
  await core.sync(db, hub);
  expect((await handlers.status({})).pendingUiEdits).toBe(0);
  const other = new TestSql(); databases.push(other.db);
  await core.sync(other, hub);
  expect((await core.listViews(other, { table: 'items' })).views).toEqual([created]);
  const edited = await core.saveView(other, { id: created.id, expectedUpdatedAt: created.updated_at!, table: 'items', name: 'Changed elsewhere', definition: { version: 1 } });
  await core.sync(other, hub);
  await core.sync(db, hub);
  await expect(handlers.deleteView({ id: created.id, expectedUpdatedAt: created.updated_at! })).rejects.toBeInstanceOf(core.ValidationError);
  await handlers.deleteView({ id: created.id, expectedUpdatedAt: edited.updated_at! });
  await core.sync(db, hub);
  await core.sync(other, hub);
  expect((await core.listViews(other, { table: 'items' })).views).toEqual([]);
  expect((await other.all("SELECT col FROM history WHERE tbl='views' ORDER BY col"))).toEqual([{ col: 'definition' }, { col: 'deleted_at' }, { col: 'name' }]);
  expect(requests.filter(r => r.route === '/v1/schema/push')).toEqual([]);
});
