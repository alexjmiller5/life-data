import { expect,test } from 'bun:test';
import { readCatalog } from '../src/catalog.ts';
import { setup,T0,T1 } from './support.ts';
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
