import {afterEach, expect, test} from 'bun:test';
import * as core from '../src/index.ts';
import {TestSql,schema,setup,T0,T1} from './support.ts';
import views from '../schema/saved-views.json';
import defaults from '../schema/view-defaults.json';
const opened:TestSql[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.db.close();});
async function fixture(provision=true) {
 const db=new TestSql();opened.push(db);
 for(const ddl of schema)await db.run(ddl);
 await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
 await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
 await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
 await db.run("INSERT INTO catalog_tables(id,kind,display) VALUES ('items','table','name'),('elsewhere','table','name')");
 await db.run('CREATE TABLE elsewhere(id TEXT PRIMARY KEY,name TEXT,updated_at TEXT,deleted_at TEXT)');
 await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.name','items','name','text'),('elsewhere.name','elsewhere','name','text')");
 for(const storage of [views,...(provision?[defaults]:[])]) {
  for(const ddl of storage.ddl)await db.run(ddl);
  await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)',[storage.table.id,storage.table.kind,storage.table.display]);
  for(const property of storage.properties){const keys=Object.keys(property);await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(()=>'?')})`,Object.values(property));}
 }
 const view=await core.saveView(db,{table:'items',name:'Everyday',definition:{version:1,columns:['name']}});
 const other=await core.saveView(db,{table:'elsewhere',name:'Other',definition:{version:1}});
 return {db,view,other};
}
test('default is absent without a write, then persists a stable saved-view identity',async()=>{
 const {db,view}=await fixture();
 const initial=await core.getViewDefault(db,{table:'items'});
 expect(initial.view).toBeNull();expect(initial.updated_at).toBeNull();expect(initial.unavailable).toBeNull();
 expect(await db.all('SELECT * FROM view_defaults')).toEqual([]);
 const saved=await core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:null});
 expect(saved.view?.id).toBe(view.id);expect(saved.viewId).toBe(view.id);expect(saved.updated_at).toBeString();
 expect(await core.getViewDefault(db,{table:'items'})).toEqual(saved);
 expect((await core.syncStatus(db)).pendingUiEdits).toBeGreaterThan(0);
 await expect(core.setViewDefault(db,{table:'items',viewId:null,expectedUpdatedAt:null})).rejects.toThrow(/changed/i);
 const cleared=await core.setViewDefault(db,{table:'items',viewId:null,expectedUpdatedAt:saved.updated_at});
 expect(cleared.view).toBeNull();expect(cleared.unavailable).toBeNull();
});
test('wrong-table, missing, deleted and invalid views cannot become defaults',async()=>{
 const {db,view,other}=await fixture();
 for(const id of [other.id,'missing']) await expect(core.setViewDefault(db,{table:'items',viewId:id,expectedUpdatedAt:null})).rejects.toThrow(/available/i);
 await db.run('UPDATE views SET definition=? WHERE id=?',['{"version":99}',view.id]);
 await expect(core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:null})).rejects.toThrow(/available/i);
 expect(await db.all('SELECT * FROM view_defaults')).toEqual([]);
});
test('deleted or changed defaults fall back visibly without rewriting user views or preferences',async()=>{
 const {db,view,other}=await fixture();
 await core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:null});
 await db.run('UPDATE views SET deleted_at=? WHERE id=?',['2026-01-02T00:00:00.000Z',view.id]);
 const before=await db.all('SELECT * FROM view_defaults');
 let result=await core.getViewDefault(db,{table:'items'});
 expect(result.view).toBeNull();expect(result.viewId).toBe(view.id);expect(result.unavailable).toBeTruthy();
 expect(await db.all('SELECT * FROM view_defaults')).toEqual(before);
 await db.run('UPDATE view_defaults SET view_id=?',[other.id]);
 const changed=await db.all('SELECT * FROM view_defaults');
 result=await core.getViewDefault(db,{table:'items'});expect(result.view).toBeNull();expect(result.unavailable).toBeTruthy();
 expect(await db.all('SELECT * FROM view_defaults')).toEqual(changed);
 expect((await db.all('SELECT deleted_at FROM views WHERE id=?',[view.id]))[0].deleted_at).toBe('2026-01-02T00:00:00.000Z');
});
test('unprovisioned or mismatched storage remains visible and is never adopted or created',async()=>{
 const {db}=await fixture(false);
 expect((await core.getViewDefault(db,{table:'items'})).unavailable).toMatch(/provision/i);
 await expect(core.setViewDefault(db,{table:'items',viewId:null,expectedUpdatedAt:null})).rejects.toThrow(/provision/i);
 expect(await db.all("SELECT name FROM sqlite_master WHERE name='view_defaults'")).toEqual([]);
 await db.run('CREATE TABLE view_defaults(id TEXT)');
 expect((await core.getViewDefault(db,{table:'items'})).unavailable).toMatch(/schema/i);
});

test('cleared tombstoned preferences can be restored with their displayed revision',async()=>{
 const {db,view}=await fixture();
 await core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:null});
 await db.run("UPDATE view_defaults SET deleted_at='2026-01-02T00:00:00.000Z'");
 const state=await core.getViewDefault(db,{table:'items'});
 expect(state.view).toBeNull();expect(state.updated_at).toBeString();
 const restored=await core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:state.updated_at});
 expect(restored.view?.id).toBe(view.id);
 expect((await db.all('SELECT deleted_at FROM view_defaults'))[0].deleted_at).toBeNull();
});

test('arguments are copied without getters; malformed revisions and extra fields fail before writes',async()=>{
 const {db,view}=await fixture();let invoked=false;
 const bad={table:'items',get viewId(){invoked=true;return view.id;},expectedUpdatedAt:null};
 await expect(core.setViewDefault(db,bad)).rejects.toThrow();expect(invoked).toBe(false);
 for(const expectedUpdatedAt of ['', 'yesterday', 1])await expect(core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt} as any)).rejects.toThrow();
 await expect(core.getViewDefault(db,{table:'items',extra:true} as any)).rejects.toThrow();
 expect(await db.all('SELECT * FROM view_defaults')).toEqual([]);
});
test('ordinary history and Undo preserve the prior default selection',async()=>{
 const {db,view}=await fixture();
 const handlers=core.createCoreHandlers(db,()=>{throw Error('No network allowed');},'fixture');
 await handlers.setViewDefault({table:'items',viewId:view.id,expectedUpdatedAt:null});
 const action=(await handlers.undoStatus({})).action;
 expect(action?.table).toBe('view_defaults');
 expect(action).not.toBeNull();
 await handlers.undo({receiptId:action!.receiptId});
 expect((await handlers.getViewDefault({table:'items'})).view).toBeNull();
});

test('related-record preferences have independent storage, revision guards and Undo',async()=>{
 const {db,view}=await fixture();
 const handlers:any=core.createCoreHandlers(db,()=>{throw Error('No network allowed');});
 expect(typeof handlers.getRelatedViewDefault).toBe('function');
 const absent=await handlers.getRelatedViewDefault({table:'items'});
 expect(absent.view).toBeNull();expect(absent.unavailable).toMatch(/provision/i);
 const storage=await Bun.file(new URL('../schema/related-view-defaults.json',import.meta.url)).json();
 for(const ddl of storage.ddl)await db.run(ddl);
 await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)',[storage.table.id,storage.table.kind,storage.table.display]);
 for(const p of storage.properties){const keys=Object.keys(p);await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(()=>'?')})`,Object.values(p));}
 const ordinary=await handlers.setViewDefault({table:'items',viewId:view.id,expectedUpdatedAt:null});
 const linked=await core.saveView(db,{table:'items',name:'Related',definition:{version:1,filters:[{column:'name',op:'ne',value:'Excluded'}]}});
 const related=await handlers.setRelatedViewDefault({table:'items',viewId:linked.id,expectedUpdatedAt:null});
 expect(related.view.id).toBe(linked.id);
 expect(await handlers.getViewDefault({table:'items'})).toEqual(ordinary);
 await expect(handlers.setRelatedViewDefault({table:'items',viewId:null,expectedUpdatedAt:null})).rejects.toThrow(/changed/i);
 const action=(await handlers.undoStatus({})).action;
 expect(action.table).toBe('related_view_defaults');
 await handlers.undo({receiptId:action.receiptId});
 expect((await handlers.getRelatedViewDefault({table:'items'})).view).toBeNull();
 expect(await handlers.getViewDefault({table:'items'})).toEqual(ordinary);
});

test('opening a table without a preference creates one catalog default view and points to it',async()=>{
 const {db,view}=await fixture();
 const handlers=core.createCoreHandlers(db,()=>{throw Error('No network allowed');});
 const opened=await handlers.ensureDefaultView({table:'items'});
 expect(opened.view?.definition).toEqual({version:1});expect(opened.view?.name).toBe('Default view');
 expect(opened.viewId).toBe(opened.view!.id);expect(opened.unavailable).toBeNull();
 expect(await handlers.ensureDefaultView({table:'items'})).toEqual(opened);
 expect(await handlers.getViewDefault({table:'items'})).toEqual(opened);
 expect((await db.all("SELECT id FROM views WHERE tbl='items' AND deleted_at IS NULL")).length).toBe(2);
 // Automatic setup is not a human action.
 expect((await handlers.undoStatus({})).action).toBeNull();
 // An explicit preference wins and is never rewritten.
 const chosen=await handlers.setViewDefault({table:'items',viewId:view.id,expectedUpdatedAt:opened.updated_at});
 expect(await handlers.ensureDefaultView({table:'items'})).toEqual(chosen);
});
test('a deleted default view is restored; an unavailable preference keeps its notice and row',async()=>{
 const {db,view}=await fixture();
 const first=await core.ensureDefaultView(db,{table:'items'});
 await core.deleteView(db,{id:first.view!.id,expectedUpdatedAt:first.view!.updated_at!});
 const restored=await core.ensureDefaultView(db,{table:'items'});
 expect(restored.view?.id).toBe(first.view!.id);expect(restored.view?.deleted_at).toBeNull();
 const pointed=await core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:restored.updated_at});
 await db.run('UPDATE views SET deleted_at=? WHERE id=?',['2026-01-02T00:00:00.000Z',view.id]);
 const before=await db.all('SELECT * FROM view_defaults');
 const fallback=await core.ensureDefaultView(db,{table:'items'});
 expect(fallback.viewId).toBe(view.id);expect(fallback.unavailable).toBeTruthy();
 expect(fallback.view?.id).toBe(first.view!.id);
 expect(await db.all('SELECT * FROM view_defaults')).toEqual(before);expect(pointed.view?.id).toBe(view.id);
});
test('default views are created without preference storage and never provision either store',async()=>{
 const {db}=await fixture(false);
 const opened=await core.ensureDefaultView(db,{table:'items'});
 expect(opened.view?.name).toBe('Default view');expect(opened.unavailable).toMatch(/provision/i);
 expect((await core.ensureDefaultView(db,{table:'items'})).view?.id).toBe(opened.view!.id);
 expect(await db.all("SELECT name FROM sqlite_master WHERE name='view_defaults'")).toEqual([]);
 await db.run('DROP TABLE views');
 const none=await core.ensureDefaultView(db,{table:'elsewhere'});
 expect(none.view).toBeNull();
 expect(await db.all("SELECT name FROM sqlite_master WHERE name='views'")).toEqual([]);
});
test('opening a table reads only the catalog rows of the tables it involves',async()=>{
 const {db,view}=await fixture();
 await core.setViewDefault(db,{table:'items',viewId:view.id,expectedUpdatedAt:null});
 const read:{sql:string;rows:Record<string,unknown>[]}[]=[];
 const all=db.all.bind(db);
 db.all=async(sql,params)=>{const rows=await all(sql,params);if(/FROM\s+"?catalog_(tables|properties|rules)/.test(sql))read.push({sql,rows});return rows;};
 const tablesOf=()=>new Set(read.flatMap(r=>r.rows.map(row=>String(/catalog_tables/.test(r.sql)?row.id:row.tbl))));
 await core.ensureDefaultView(db,{table:'items'});
 await core.listViews(db,{table:'items'});
 await core.readRows(db,{table:'items',columns:['name']});
 expect(read.length).toBeGreaterThan(0);
 expect([...tablesOf()].sort()).toEqual(['items','view_defaults','views']);
 read.length=0;
 await core.mentionLabels(db,{targets:[{table:'items',id:'missing'}]});
 expect([...tablesOf()]).toEqual(['items']);
});

test('a table opened on a hub replica pushes its new view before the preference that points at it',async()=>{
 const {db,remote,hub}=setup();opened.push(db,remote as unknown as TestSql);
 const ddl=['ALTER TABLE catalog_properties ADD COLUMN source TEXT','ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT',
  'CREATE TABLE catalog_tables (id TEXT PRIMARY KEY,kind TEXT,display TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
  ...views.ddl,...defaults.ddl];
 for(const sql of ddl){remote.db.exec(sql);remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0,sql);}
 for(const table of [{id:'items',kind:'table',display:'name'},views.table,defaults.table])remote.db.query('INSERT INTO catalog_tables(id,kind,display,updated_at,hub_at) VALUES (?,?,?,?,?)').run(table.id,table.kind,table.display,T0,T1);
 for(const p of [...views.properties,...defaults.properties,{id:'items.name',tbl:'items',col:'name',type:'text'}]){
  const row={...p,updated_at:T0,hub_at:T1};const keys=Object.keys(row);
  remote.db.query(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...(Object.values(row) as never[]));
 }
 await core.sync(db,hub);
 const handlers=core.createCoreHandlers(db,()=>{throw new Error('unused');},'fixture');
 const shown=await handlers.ensureDefaultView({table:'items'});
 expect(shown.view?.name).toBe('Default view');
 const round=await core.sync(db,hub);
 expect(round.rejected).toEqual([]);
 expect(await db.all('SELECT * FROM _core_rejected')).toEqual([]);
 expect((await handlers.status({})).pendingUiEdits).toBe(0);
 expect(remote.db.query('SELECT view_id FROM view_defaults').all()).toEqual([{view_id:shown.view!.id}]);
});
