import {afterEach,expect,test} from 'bun:test';
import * as edit from '../src/catalog-edit.ts';
import {TestSql,schema,T0,setup} from './support.ts';
import {sync} from '../src/sync.ts';
import {writeRow} from '../src/write.ts';
const opened:TestSql[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.db.close();});
async function fixture(){
 const db=new TestSql();opened.push(db);for(const ddl of schema)await db.run(ddl);
 await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
 await db.run("INSERT INTO catalog_tables VALUES ('items','table','name',NULL)");
 await db.run('ALTER TABLE catalog_properties ADD COLUMN label TEXT');
 await db.run('ALTER TABLE catalog_properties ADD COLUMN description TEXT');
 await db.run('ALTER TABLE catalog_rules ADD COLUMN scope TEXT');
 await db.run('ALTER TABLE catalog_rules ADD COLUMN cmd TEXT');
 await db.run('CREATE TABLE catalog_log(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,action TEXT,payload TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
 await db.run("INSERT INTO catalog_properties(id,tbl,col,type,updated_at) VALUES ('items.name','items','name','text',?)",[T0]);
 await db.run("INSERT INTO items(id,name,created_at,updated_at) VALUES ('one','Existing',?,?)",[T0,T0]);return db;
}
test('property edit preserves identity, persists option descriptions, logs once and detects stale edits',async()=>{
 const db=await fixture();
 const args={table:'items',column:'name',expectedUpdatedAt:T0,fields:{type:'select',label:'Stage',options:[{v:'Draft',d:'Work in progress'},{v:'Ready',d:'Reviewed'}]}};
 const row=await edit.saveCatalogProperty(db,args);
 expect(row.id).toBe('items.name');expect(row.options).toEqual(args.fields.options);
 const log=await db.all('SELECT * FROM catalog_log');expect(log).toHaveLength(1);expect(log[0]).toMatchObject({tbl:'catalog_properties',row_id:'items.name',action:'set'});
 expect(JSON.parse(String(log[0].payload))).toMatchObject(args.fields);
 expect(await db.all('SELECT name FROM items')).toEqual([{name:'Existing'}]);
 await expect(edit.saveCatalogProperty(db,args)).rejects.toThrow(/changed/i);
 expect(await db.all('SELECT * FROM catalog_log')).toHaveLength(1);
 expect(await db.all('SELECT * FROM _core_pending')).toHaveLength(2);
});
test('adding a property logs the physical column and catalog metadata atomically',async()=>{
 const db=await fixture();
 await edit.saveCatalogProperty(db,{table:'items',column:'score',addColumn:true,expectedUpdatedAt:null,fields:{type:'number',description:'Review score'}});
 expect((await db.all('PRAGMA table_info(items)')).find(r=>r.name==='score')?.type).toBe('REAL');
 expect((await db.all('SELECT ddl FROM _schema_log')).map(r=>r.ddl)).toEqual(['ALTER TABLE "items" ADD COLUMN "score" REAL']);
 expect(await db.all('SELECT score FROM items')).toEqual([{score:null}]);
 expect(await db.all('SELECT * FROM catalog_log')).toHaveLength(1);
});
test('rule edits compile portable contexts, preserve exact guidance and reject unsafe enforcement',async()=>{
 const db=await fixture();
 const fields={scope:'table',kind:'invariant',text:'A name is required before saving.',sql:"SELECT id FROM changed WHERE name IS NULL",enforce:1};
 const row=await edit.saveCatalogRule(db,{table:'items',id:'name-required',expectedUpdatedAt:null,fields});
 expect(row.text).toBe(fields.text);expect(row.tbl).toBe('items');
 for(const sql of ['DELETE FROM items','SELECT * FROM nonexistent','SELECT random() FROM changed']){
  await expect(edit.saveCatalogRule(db,{table:'items',id:'bad',expectedUpdatedAt:null,fields:{...fields,sql}})).rejects.toThrow();
 }
 expect(await db.all('SELECT id FROM catalog_rules')).toEqual([{id:'name-required'}]);
 expect(await db.all('SELECT * FROM catalog_log')).toHaveLength(1);
});
test('invalid input, protected tables and log failures leave schema and catalog untouched',async()=>{
 const db=await fixture();
 const args={table:'items',column:'score',expectedUpdatedAt:null,addColumn:true,fields:{type:'number'}};
 for(const fields of [{type:'unknown'},{type:'text',required:1,derived_by:'http:fixture'},{type:'text',id:'other'}])await expect(edit.saveCatalogProperty(db,{...args,fields})).rejects.toThrow();
 await expect(edit.saveCatalogProperty(db,{...args,table:'history'})).rejects.toThrow();
 await db.run("CREATE TRIGGER reject_log BEFORE INSERT ON catalog_log BEGIN SELECT RAISE(ABORT,'no log'); END");
 await expect(edit.saveCatalogProperty(db,args)).rejects.toThrow();
 expect((await db.all('PRAGMA table_info(items)')).some(r=>r.name==='score')).toBe(false);
 expect(await db.all("SELECT * FROM catalog_properties WHERE id='items.score'")).toEqual([]);
 expect(await db.all('SELECT * FROM catalog_log')).toEqual([]);
});
test('an invalid rule can be repaired through the catalog without allowing a record write',async()=>{
 const db=await fixture();
 await db.run("INSERT INTO catalog_rules(id,tbl,scope,kind,sql,enforce,updated_at) VALUES ('repair','items','table','invariant','SELECT random() FROM changed',1,?)",[T0]);
 await expect(writeRow(db,'items',{id:'one',name:'Blocked'})).rejects.toThrow(/unsupported SQL/);
 const row=await edit.saveCatalogRule(db,{table:'items',id:'repair',expectedUpdatedAt:T0,fields:{sql:'SELECT id FROM changed WHERE name IS NULL',text:'Name required'}});
 expect(row.sql).toBe('SELECT id FROM changed WHERE name IS NULL');
});
test('failure while logging rolls back physical DDL and metadata together',async()=>{
 const db=await fixture();const run=db.run.bind(db);
 db.run=async(sql,params)=>{if(sql.startsWith('INSERT INTO main.catalog_log'))throw Error('Synthetic log failure');return run(sql,params);};
 await expect(edit.saveCatalogProperty(db,{table:'items',column:'score',addColumn:true,expectedUpdatedAt:null,fields:{type:'number'}})).rejects.toThrow('Synthetic log failure');
 expect((await db.all('PRAGMA table_info(items)')).some(r=>r.name==='score')).toBe(false);
 expect(await db.all("SELECT * FROM catalog_properties WHERE id='items.score'")).toEqual([]);
});
test('input getters never run',async()=>{
 const db=await fixture();let invoked=false;
 const options:any[]=[];Object.defineProperty(options,'0',{enumerable:true,get(){invoked=true;return {v:'Bad'};}});
 await expect(edit.saveCatalogProperty(db,{table:'items',column:'name',expectedUpdatedAt:T0,fields:{options}})).rejects.toThrow();
 expect(invoked).toBe(false);
});

test('catalog edits and their logs reach the real Worker and another replica through ordinary sync',async()=>{
 const source=await fixture();const {db,remote,hub}=setup();opened.push(db);
 try{
  for(const table of ['items','catalog_properties','catalog_rules','history'])remote.db.exec('DROP TABLE '+table);
  remote.db.exec('DELETE FROM _schema_log');
  for(const row of await source.all("SELECT sql,name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")){
   remote.db.exec(String(row.sql));remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0,String(row.sql));
   for(const record of await source.all('SELECT * FROM "'+row.name+'"')){
    const keys=Object.keys(record);remote.db.query('INSERT INTO "'+row.name+'"('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...Object.values(record) as any[]);
   }
  }
  // Every pulled row must have a real revision, including fixture metadata.
  remote.db.exec("ALTER TABLE catalog_tables ADD COLUMN updated_at TEXT; ALTER TABLE catalog_tables ADD COLUMN hub_at TEXT; UPDATE catalog_tables SET updated_at='"+T0+"'");
  for(const ddl of ['ALTER TABLE catalog_tables ADD COLUMN updated_at TEXT','ALTER TABLE catalog_tables ADD COLUMN hub_at TEXT'])remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0,ddl);
  await sync(db,hub);
  const row=await edit.saveCatalogProperty(db,{table:'items',column:'rating',addColumn:true,expectedUpdatedAt:null,fields:{type:'select',options:[{v:'Good',d:'Reviewed positively'}],description:'Synthetic rating'}});
  const result=await sync(db,hub);expect(result.rejected).toEqual([]);
  expect(remote.db.query("SELECT description FROM catalog_properties WHERE id='items.rating'").get()).toEqual({description:'Synthetic rating'});
  expect(remote.db.query("SELECT row_id FROM catalog_log").all()).toEqual([{row_id:row.id}]);
  const second=new TestSql();opened.push(second);await sync(second,hub);
  await writeRow(second,'items',{id:'one',rating:'Good'},{expectedUpdatedAt:T0});
  await expect(writeRow(second,'items',{id:'one',rating:'Bad'})).rejects.toThrow(/option/);
 }finally{remote.db.close();}
});

test('malformed prior option metadata can be repaired without changing stored records',async()=>{
 const db=await fixture();await db.run("UPDATE catalog_properties SET options='not-json' WHERE id='items.name'");
 const row=await edit.saveCatalogProperty(db,{table:'items',column:'name',expectedUpdatedAt:T0,fields:{options:[{v:'Fixed',d:'Valid option'}]}});
 expect(row.options).toEqual([{v:'Fixed',d:'Valid option'}]);
 expect(await db.all('SELECT name FROM items')).toEqual([{name:'Existing'}]);
});
