import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import manifest from '../schema/sidebar-pins.json';
import { schema, TestSql, T0, T1, setup } from './support.ts';

const databases: TestSql[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.db.close(); });
async function local(provision = true, path?: string) {
  const db = new TestSql(); databases.push(db);
  if (path) { db.db.close(); db.db = new Database(path); }
  for (const ddl of schema) await db.run(ddl);
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,kind,display) VALUES ('items','table','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text')");
  await db.run('CREATE TABLE projects(id TEXT PRIMARY KEY,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,kind,display) VALUES ('projects','table','id')");
  if (provision) {
    for (const ddl of manifest.ddl) await db.run(ddl);
    for (const [table, records] of [['catalog_tables', [manifest.table]], ['catalog_properties', manifest.properties]] as const) {
      for (const row of records) {
        const cols = Object.keys(row);
        await db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row));
      }
    }
  }
  return db;
}
const active = (result: core.SidebarPinList) => result.pins.filter(p => !p.deleted_at);
const revisions = (result: core.SidebarPinList) => active(result).map(({id, updated_at}) => ({id, updated_at}));
const pin = (db: core.SqlDriver, table: string, expectedUpdatedAt: string | null = null) => core.pinTable(db, {table, expectedUpdatedAt});

test('missing pin storage is unavailable and never changes schema or rows', async () => {
  const db = await local(false);
  const before = await db.all('SELECT name,sql FROM sqlite_master ORDER BY name');
  const listed = await core.listSidebarPins(db, {});
  expect(listed.pins).toEqual([]);
  expect(listed.unavailable).toMatch(/provision|setup/i);
  await expect(core.pinTable(db, { table: 'items', expectedUpdatedAt: null })).rejects.toThrow(/provision|setup/i);
  expect(await db.all('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('nonalphabetical pins survive an actual file reopen without local preferences', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-pins-'));
  try {
    const path = join(directory, 'fixture.sqlite');
    const db = await local(true, path);
    await pin(db, 'projects');
    const stored = await pin(db, 'items');
    expect(active(stored).map(p => p.tbl)).toEqual(['projects', 'items']);
    expect((await core.syncStatus(db)).pendingUiEdits).toBe(2);
    db.db.close(); db.db = new Database(path);
    expect(await core.listSidebarPins(db, {})).toEqual(stored);
  } finally { rmSync(directory, {recursive: true}); }
});

test('unpin and restore reuse the same row with revision and history guards', async () => {
  const db = await local();
  const first = (await pin(db, 'items')).pins[0];
  const removed = await core.unpinTable(db, {id:first.id,expectedUpdatedAt:first.updated_at});
  expect(active(removed)).toEqual([]);
  expect(removed.pins[0].deleted_at).toBe(removed.pins[0].updated_at);
  await expect(pin(db, 'items', first.updated_at)).rejects.toThrow(/changed|revision|reload/i);
  await expect(pin(db, 'items')).rejects.toThrow(/changed|revision|reload/i);
  const restored = await pin(db, 'items', removed.pins[0].updated_at);
  expect(active(restored).map(p => p.id)).toEqual([first.id]);
  expect((await db.all('SELECT count(*) AS n FROM sidebar_pins'))[0].n).toBe(1);
  expect(await db.all("SELECT col FROM history WHERE tbl='sidebar_pins' ORDER BY rowid")).toEqual([{col:'deleted_at'},{col:'deleted_at'}]);
});

test('missing targets stay visible and can be unpinned through the normal tombstone writer', async () => {
  const db = await local();
  const first = (await pin(db, 'items')).pins[0];
  await db.run("UPDATE catalog_tables SET deleted_at=? WHERE id='items'",[T1]);
  expect((await core.listSidebarPins(db, {})).pins[0].unavailable).toMatch(/unavailable|catalog/i);
  expect(active(await core.unpinTable(db,{id:first.id,expectedUpdatedAt:first.updated_at}))).toEqual([]);
});

test('moving checks the complete selected revision set and swaps only after a receipt', async () => {
  const db = await local();
  await pin(db,'projects');
  const before=await pin(db,'items');
  const moved=await core.moveTablePin(db,{id:before.pins[1].id,direction:'up',expected:revisions(before)});
  expect(active(moved).map(p=>p.tbl)).toEqual(['items','projects']);
  await expect(core.moveTablePin(db,{id:before.pins[0].id,direction:'up',expected:revisions(before)})).rejects.toThrow(/changed|revision|reload/i);
  expect(await core.listSidebarPins(db,{})).toEqual(moved);
  expect(await core.moveTablePin(db,{id:moved.pins[0].id,direction:'up',expected:revisions(moved)})).toEqual(moved);
});

test('concurrent equal positions still support ordering and preserve byte-exact ties', async () => {
  const db=await local(); await pin(db,'projects'); await pin(db,'items');
  await db.run('UPDATE sidebar_pins SET position=3');
  const before=await core.listSidebarPins(db,{});
  expect(active(before).map(p=>p.tbl)).toEqual(['items','projects']);
  const after=await core.moveTablePin(db,{id:before.pins[1].id,direction:'up',expected:revisions(before)});
  expect(active(after).map(p=>p.tbl)).toEqual(['projects','items']);
  expect(new Set(active(after).map(p=>p.position)).size).toBe(2);
});

test('a failed second reorder write rolls back rows, history and pending receipts', async () => {
  const db=await local(); await pin(db,'projects'); const before=await pin(db,'items');
  const history=await db.all('SELECT * FROM history');
  const pending=await db.all('SELECT * FROM _core_pending');
  const run=db.run.bind(db); let writes=0;
  db.run=async(sql,params)=>{if(sql.startsWith('UPDATE OR ABORT main."sidebar_pins"') && ++writes===2)throw Error('Synthetic disk failure');return run(sql,params);};
  await expect(core.moveTablePin(db,{id:before.pins[1].id,direction:'up',expected:revisions(before)})).rejects.toThrow();
  db.run=run;
  expect(writes).toBe(2);
  expect(await core.listSidebarPins(db,{})).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual(history);
  expect(await db.all('SELECT * FROM _core_pending')).toEqual(pending);
});

test.each([
  'DROP TRIGGER sidebar_pins_updated_at',
  'ALTER TABLE sidebar_pins ADD COLUMN foreign_data TEXT',
  "UPDATE catalog_properties SET source_ref=NULL WHERE id='sidebar_pins.tbl'",
  "UPDATE catalog_tables SET kind='system' WHERE id='sidebar_pins'",
])('foreign or changed pin storage is preserved: %s',async sql=>{
  const db=await local(); await pin(db,'items'); await db.run(sql);
  const before=await db.all('SELECT * FROM sidebar_pins');
  expect((await core.listSidebarPins(db,{})).unavailable).toBeTruthy();
  await expect(pin(db,'projects')).rejects.toThrow();
  expect(await db.all('SELECT * FROM sidebar_pins')).toEqual(before);
});

test.each([{}, {table:'items'}, {table:'absent',expectedUpdatedAt:null}, {table:'items',expectedUpdatedAt:'invalid'}, {table:'items',expectedUpdatedAt:null,sql:'DELETE'}])('invalid pin input changes nothing: %j',async args=>{
  const db=await local();
  await expect(core.pinTable(db,args as core.PinTableArgs)).rejects.toThrow();
  expect(await db.all('SELECT * FROM sidebar_pins')).toEqual([]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('arguments are snapshotted before an asynchronous wait',async()=>{
  const db=await local(); const args={table:'items',expectedUpdatedAt:null};
  const saving=core.pinTable(db,args); args.table='projects';
  expect(active(await saving).map(p=>p.tbl)).toEqual(['items']);
});

test('pins converge through the real Worker and restore on a fresh replica', async () => {
  const {db,remote,hub,requests}=setup(); databases.push(db);
  try {
    const ddl=[
      'ALTER TABLE catalog_properties ADD COLUMN source TEXT',
      'ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT',
      'CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
      'CREATE TABLE projects(id TEXT PRIMARY KEY,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
      ...manifest.ddl,
    ];
    for(const sql of ddl){remote.db.exec(sql);remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0,sql);}
    for(const [table,rows] of [
      ['catalog_tables',[{id:'items',kind:'table',display:'name'},{id:'projects',kind:'table',display:'id'},manifest.table]],
      ['catalog_properties',manifest.properties],
    ] as const){
      for(const row of rows){
        const stored={...row,updated_at:T0,hub_at:T1}; const keys=Object.keys(stored);
        remote.db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(stored));
      }
    }
    await core.sync(db,hub);
    const other=new TestSql(); databases.push(other); await core.sync(other,hub);
    // Both devices add different pins offline at position zero. Neither overwrites the collection.
    await pin(db,'projects'); await pin(other,'items');
    await core.sync(db,hub); await core.sync(other,hub); await core.sync(db,hub);
    const converged=await core.listSidebarPins(db,{});
    expect(active(converged).map(p=>p.tbl)).toEqual(['items','projects']);
    expect(await core.listSidebarPins(other,{})).toEqual(converged);
    const moved=await core.moveTablePin(db,{id:converged.pins[1].id,direction:'up',expected:revisions(converged)});
    await core.sync(db,hub); await core.sync(other,hub);
    expect(await core.listSidebarPins(other,{})).toEqual(moved);
    await expect(core.unpinTable(other,{id:converged.pins[0].id,expectedUpdatedAt:converged.pins[0].updated_at})).rejects.toThrow(/changed|revision/);
    const removed=await core.unpinTable(other,{id:moved.pins[0].id,expectedUpdatedAt:moved.pins[0].updated_at});
    await core.sync(other,hub); await core.sync(db,hub);
    expect(await core.listSidebarPins(db,{})).toEqual(removed);
    const restored=await pin(db,'projects',removed.pins.find(p=>p.tbl==='projects')!.updated_at);
    await core.sync(db,hub);
    const fresh=new TestSql(); databases.push(fresh); await core.sync(fresh,hub);
    expect(await core.listSidebarPins(fresh,{})).toEqual(restored);
    expect((await core.syncStatus(fresh)).pendingUiEdits).toBe(0);
    expect(requests.filter(r=>r.route==='/v1/schema/push')).toEqual([]);
    expect(await fresh.all("SELECT col FROM history WHERE tbl='sidebar_pins' AND col='deleted_at'")).toHaveLength(2);
  } finally { remote.db.close(); }
});

test('normal enforced write restrictions also guard pin mutations',async()=>{
  const db=await local();
  await db.run("INSERT INTO catalog_rules(id,tbl,kind,enforce) VALUES ('hold','sidebar_pins','invariant',1)");
  await expect(pin(db,'items')).rejects.toBeInstanceOf(core.ValidationError);
  expect(await db.all('SELECT * FROM sidebar_pins')).toEqual([]);
});

test('getter arguments are rejected without invoking user code',async()=>{
  const db=await local();let calls=0;
  await expect(core.pinTable(db,{get table(){calls++;return 'items';},expectedUpdatedAt:null})).rejects.toThrow();
  expect(calls).toBe(0);
});

test('failed reads are errors, never authoritative empty pin lists',async()=>{
  const db=await local(); await pin(db,'items');const all=db.all.bind(db);
  db.all=async(sql,params)=>{if(sql.includes('FROM main.sidebar_pins'))throw Error('Synthetic read failure');return all(sql,params);};
  await expect(core.listSidebarPins(db,{})).rejects.toThrow('Synthetic read failure');
});

test('session pin commands serialize and do not replace the last record undo receipt',async()=>{
  const db=await local();
  const handlers=core.createCoreHandlers(db,()=>{throw Error('No fixture network');},'fixture');
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['record','Before',T0]);
  await handlers.write({table:'items',patch:{id:'record',name:'After'},expectedUpdatedAt:T0});
  const undo=await handlers.undoStatus({});
  await Promise.all([handlers.pinTable({table:'projects',expectedUpdatedAt:null}),handlers.pinTable({table:'items',expectedUpdatedAt:null})]);
  const stored=await handlers.listSidebarPins({});
  expect(active(stored).map(p=>p.tbl)).toEqual(['projects','items']);
  expect(await handlers.undoStatus({})).toEqual(undo);
  await handlers.undo({receiptId:undo.action!.receiptId});
  expect((await db.all("SELECT name FROM items WHERE id='record'"))[0].name).toBe('Before');
  expect(await handlers.listSidebarPins({})).toEqual(stored);
});

test('every sidebar-pins schema property carries a description (the estate column-descriptions rule refuses provisioning without one)', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(readFileSync(new URL('../schema/sidebar-pins.json', import.meta.url), 'utf8'));
  for (const property of schema.properties) {
    expect(typeof property.description === 'string' && property.description.trim().length > 0, property.col).toBe(true);
  }
});
