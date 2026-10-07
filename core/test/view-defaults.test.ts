import {afterEach, expect, test} from 'bun:test';
import * as core from '../src/index.ts';
import {TestSql,schema} from './support.ts';
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
