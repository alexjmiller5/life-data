import { expect, test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { checkedReads, prepareChecked, readGuards } from '../src/write.js';

const time='2026-01-01T00:00:00.000Z';
async function plans(db) {
  const view=checkedReads(db);
  await view.prepare('SELECT * FROM items ORDER BY id').all();
  await view.prepare('SELECT * FROM origins ORDER BY id').all();
  const out=[];
  for(const [table,id,value] of [['items','one','new'],['origins','edge','evidence']]) {
    const row={id,value,updated_at:time,deleted_at:null};
    out.push(await prepareChecked(db,table,[],[
      db.prepare(`INSERT INTO ${table} (id,value,updated_at) VALUES (?,?,?) RETURNING id`).bind(id,value,time),
    ],time,null,[row],[],[{before:null,after:row,touched:Object.keys(row)}]));
  }
  return [
    ...readGuards(db,view.reads),...out.flatMap(p=>p.begin),
    ...out.flatMap(p=>p.statements),...out.flatMap(p=>p.end),
  ];
}
function setup() {
  const db=new D1Shim();
  for(const table of ['items','origins']) db.db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,value TEXT,updated_at TEXT,deleted_at TEXT)`);
  return db;
}
test('checked plans for two tables share one successful committing transaction',async()=>{
  const db=setup();
  await db.batch(await plans(db));
  expect(db.db.query('SELECT id,value FROM items').all()).toEqual([{id:'one',value:'new'}]);
  expect(db.db.query('SELECT id,value FROM origins').all()).toEqual([{id:'edge',value:'evidence'}]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});
test('late companion rejection rolls back first mutation and all helper state',async()=>{
  const db=setup();
  db.db.exec("CREATE TRIGGER reject_origin BEFORE INSERT ON origins BEGIN SELECT RAISE(ABORT,'fixture rejection'); END");
  await expect(db.batch(await plans(db))).rejects.toThrow('fixture rejection');
  for(const table of ['items','origins']) expect(db.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});
test('both plans retain property approval checks, including the second mutation',async()=>{
  const db=setup();
  db.db.exec("CREATE TRIGGER alter_origin AFTER INSERT ON origins BEGIN UPDATE origins SET value='altered' WHERE id=NEW.id; END");
  await expect(db.batch(await plans(db))).rejects.toThrow('life_write_conflict');
  expect(db.db.query('SELECT * FROM items').all()).toEqual([]);
  expect(db.db.query('SELECT * FROM origins').all()).toEqual([]);
});
test('shared read guard rejects competing membership before either mutation',async()=>{
  const db=setup(),statements=await plans(db);
  db.db.exec("INSERT INTO origins VALUES('other','concurrent',NULL,NULL)");
  await expect(db.batch(statements)).rejects.toThrow();
  expect(db.db.query('SELECT * FROM items').all()).toEqual([]);
  expect(db.db.query('SELECT id FROM origins').all()).toEqual([{id:'other'}]);
});
