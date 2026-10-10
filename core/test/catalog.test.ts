import { expect,test } from 'bun:test';
import { catalogRevision, readCatalog } from '../src/catalog.ts';
import { schema,setup,T0,T1 } from './support.ts';
import { sync } from '../src/sync.ts';

test('catalog reads decode field options and inputs and exclude retired definitions',async()=>{
  const {db,remote,hub}=setup();
  remote.db.exec('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,display TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0,'CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,display TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
  remote.db.query('INSERT INTO catalog_tables(id,display,updated_at,hub_at) VALUES (?,?,?,?)').run('items','name',T0,T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,options,inputs,updated_at,hub_at) VALUES (?,?,?,?,?,?,?,?)').run('items.name','items','name','select','[{"v":"Draft","d":"Not published"}]','["qty"]',T0,T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,updated_at,deleted_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.old','items','old',T0,T0,T1);
  await sync(db,hub);
  const catalog=await readCatalog(db);
  expect(catalog.tables).toMatchObject([{id:'items',display:'name'}]);
  expect(catalog.properties).toMatchObject([{col:'name',options:[{v:'Draft',d:'Not published'}],inputs:['qty']}]);
  expect(catalog.properties.length).toBe(1);
});

test('the catalog revision changes with every catalog row change and only then',async()=>{
  const {db}=setup();
  const revision=async()=>(await catalogRevision(db)).revision;
  const empty=await revision();
  for(const ddl of schema)await db.run(ddl);
  expect(await revision()).not.toBe(empty);
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,display TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display,updated_at) VALUES ('items','name',?)",[T0]);
  const seen=new Set([empty]);
  const changed=async(label:string)=>{const next=await revision();expect(seen.has(next),label).toBe(false);seen.add(next);expect(await revision()).toBe(next);};
  await changed('table added');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type,updated_at) VALUES ('items.name','items','name','text',?)",[T0]);
  await changed('property added');
  await db.run("UPDATE catalog_properties SET type='markdown',updated_at=? WHERE id='items.name'",[T1]);
  await changed('property edited');
  await db.run("UPDATE catalog_properties SET hub_at=? WHERE id='items.name'",[T1]);
  await changed('property pulled');
  await db.run("INSERT INTO catalog_rules(id,tbl,kind,updated_at) VALUES ('r','items','invariant',?)",[T0]);
  await changed('rule added');
  await db.run("UPDATE catalog_rules SET deleted_at=? WHERE id='r'",[T1]);
  await changed('rule retired');
  await db.run("DELETE FROM catalog_tables");
  await changed('table removed');
  await db.run("INSERT INTO items(id,name,updated_at) VALUES ('row','not catalog',?)",[T0]);
  expect(seen.has(await revision())).toBe(true);
});

test('a catalog without sync timestamps revises on any content change',async()=>{
  const {db}=setup();
  for(const ddl of schema)await db.run(ddl);
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('items','name')");
  const before=(await catalogRevision(db)).revision;
  await db.run("UPDATE catalog_tables SET display='qty'");
  expect((await catalogRevision(db)).revision).not.toBe(before);
});
