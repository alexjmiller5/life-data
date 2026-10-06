import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import { TestSql, schema } from './support.ts';
const databases: TestSql[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.db.close();});
const source='11111111222233334444555555555555';
const dashed='11111111-2222-3333-4444-555555555555';
async function local() {
  const db=new TestSql();databases.push(db);
  for(const ddl of schema)await db.run(ddl);
  await db.run('CREATE TABLE catalog_tables (id TEXT PRIMARY KEY,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('items','name'),('provenance',NULL)");
  await db.run('CREATE TABLE provenance (id TEXT PRIMARY KEY,from_kind TEXT,from_ref TEXT,to_kind TEXT,to_ref TEXT,rel TEXT,field TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO items(id,name) VALUES ('local-id','Local record')");
  await db.run("INSERT INTO provenance(id,from_kind,from_ref,to_kind,to_ref,rel) VALUES ('edge','notion',?,'items','local-id','imported_from')",[source]);
  return db;
}
async function resolve(db:TestSql,url:string) {
  const handlers:any=core.createCoreHandlers(db,()=>{throw Error('Source links must resolve locally');});
  expect(typeof handlers.resolveSourceLink).toBe('function');
  return handlers.resolveSourceLink({url});
}
test('preserved source identities resolve title URLs and dashed IDs to a fresh local destination',async()=>{
  const db=await local();
  for(const url of [`https://www.notion.so/${dashed}`,`https://app.notion.com/p/A-title-${source}?x=y`, `https://notion.so/${source}#block`])
    expect(await resolve(db,url)).toEqual({destination:{table:'items',row:'local-id'}});
  await db.run('UPDATE provenance SET from_ref=?',[dashed]);
  expect(await resolve(db,`https://notion.so/${source}`)).toEqual({destination:{table:'items',row:'local-id'}});
});
test('external, malformed and absent source identities have no implied local destination',async()=>{
  const db=await local();
  for(const url of [`https://example.com/${source}`,`https://notion.so.evil.example/${source}`,`https://user@notion.so/${source}`,`javascript:alert(1)`,`https://notion.so/%2f${source}`,`https://notion.so/${'a'.repeat(32)}`])
    expect(await resolve(db,url)).toEqual({});
});
test('only whole-record import edges count, and ambiguous destinations are never guessed',async()=>{
  const db=await local();
  await db.run("INSERT INTO items(id,name) VALUES ('other','Other')");
  await db.run("INSERT INTO provenance(id,from_kind,from_ref,to_kind,to_ref,rel) VALUES ('second','notion',?,'items','other','evidence_of')",[source]);
  expect(await resolve(db,`https://notion.so/${source}`)).toEqual({destination:{table:'items',row:'local-id'}});
  await db.run("UPDATE provenance SET rel='imported_from' WHERE id='second'");
  await expect(resolve(db,`https://notion.so/${source}`)).rejects.toThrow(/multiple/i);
});
test('deleted provenance and missing targets do not open coincidental IDs',async()=>{
  const db=await local();
  await db.run("UPDATE provenance SET deleted_at='deleted'");
  expect(await resolve(db,`https://notion.so/${source}`)).toEqual({});
  await db.run('UPDATE provenance SET deleted_at=NULL');
  await db.run('DELETE FROM items');
  expect(await resolve(db,`https://notion.so/${source}`)).toEqual({});
});
test('a workspace without source mappings still supports ordinary Markdown links',async()=>{
  const db=await local();await db.run('DROP TABLE provenance');
  expect(await resolve(db,`https://notion.so/${source}`)).toEqual({});
});
