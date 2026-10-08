import {expect,test} from 'bun:test';
import hub from '../src/index.js';
import {checkedReads,readGuards} from '../src/write.js';
import {LimitedD1} from './limited-d1.js';
import {D1Shim} from './d1shim.js';

const before='2025-01-01T00:00:00.000Z', stamp='2025-02-01T00:00:00.000Z';
const schemaSql="SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name";
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const event={id:'original',tbl:'items',row_id:'r',col:'deleted_at',old:null,new:stamp,origin:'replica',created_at:stamp,updated_at:stamp};
async function fixture(db,note='small') {
  for(const sql of [
    'CREATE TABLE items(id TEXT PRIMARY KEY,note TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
    'CREATE TABLE provenance(id TEXT PRIMARY KEY,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
    'CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)',
  ])await db.prepare(sql).run();
  await db.prepare('INSERT INTO items VALUES(?,?,?,NULL,NULL)').bind('r',note,before).run();
  const env={DB:db,HUB_TOKEN:'synthetic-token'},pending=[],ctx={waitUntil(promise){pending.push(promise);}};
  const request=async(path,body)=>{
    const response=await hub.fetch(new Request('https://hub.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic-token','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env,ctx);
    await Promise.all(pending.splice(0));
    return response;
  };
  expect((await request('/v1/catalog')).status).toBe(200);
  return body=>request('/v1/rows/push',body);
}
const tombstone=()=>({table:'items',columns:['id','updated_at','deleted_at'],rows:[{id:'r',updated_at:stamp,deleted_at:stamp}],history:[event]});

test('HTTP sparse tombstone retains original history when its trigger snapshot exceeds one D1 value',async()=>{
  const db=new LimitedD1();
  try {
    const push=await fixture(db);
    for(let i=0;i<600;i++)await db.prepare(`CREATE TRIGGER custom${i} AFTER UPDATE ON items BEGIN SELECT 1; /* ${'x'.repeat(3100)} */ END`).run();
    const initial=bytes((await db.prepare(schemaSql).all()).results);
    const empty='CREATE TRIGGER padding AFTER UPDATE ON items BEGIN SELECT 1; /*  */ END';
    await db.prepare(empty).run();
    const overhead=bytes((await db.prepare(schemaSql).all()).results)-initial;
    await db.prepare('DROP TRIGGER padding').run();
    await db.prepare(empty.replace('/*  */',`/* ${'x'.repeat(1_999_000-initial-overhead)} */`)).run();
    expect(bytes((await db.prepare(schemaSql).all()).results)).toBe(1_999_000);
    const triggers=await db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name COLLATE NOCASE IN ('items','history','provenance','_change_events','_change_subscriptions') ORDER BY name").all();
    expect(bytes(triggers.results)).toBeGreaterThan(2_000_000);
    const provenance=await push({table:'provenance',columns:['id','updated_at'],rows:[{id:'edge',updated_at:stamp}]});
    expect(provenance.status).toBe(200);expect((await provenance.json()).upserted).toBe(1);
    const response=await push(tombstone());
    expect(await response.json()).toMatchObject({upserted:1,rejected:[]});
    expect(response.status).toBe(200);
    expect(await db.prepare('SELECT updated_at,deleted_at FROM items').first()).toEqual({updated_at:stamp,deleted_at:stamp});
    expect((await db.prepare('SELECT id,col,old,new,origin,created_at,updated_at FROM history').all()).results).toEqual([{id:'original',col:'deleted_at',old:null,new:stamp,origin:'replica',created_at:stamp,updated_at:stamp}]);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).results).toEqual([]);
  } finally {await db.close();}
});

test('HTTP sparse tombstone preserves a stored cell whose JSON encoding exceeds one D1 value',async()=>{
  const db=new LimitedD1(),note='\n'.repeat(1_050_000);
  try {
    const push=await fixture(db,note);
    await db.prepare('ALTER TABLE items ADD COLUMN n INTEGER').run();
    await db.prepare('ALTER TABLE items ADD COLUMN code TEXT').run();
    await db.prepare("UPDATE items SET n=9223372036854775807,code='001'").run();
    const response=await push(tombstone());
    expect(await response.json()).toMatchObject({upserted:1,rejected:[]});
    expect(response.status).toBe(200);
    expect(await db.prepare('SELECT note,updated_at,deleted_at FROM items').first()).toEqual({note,updated_at:stamp,deleted_at:stamp});
    expect((await db.prepare('SELECT id FROM history').all()).results).toEqual([{id:'original'}]);
    expect(await db.prepare('SELECT CAST(n AS TEXT) AS n,code,typeof(code) AS kind FROM items').first())
      .toEqual({n:'9223372036854775807',code:'001',kind:'text'});
  } finally {await db.close();}
});

for(const [envelopeBytes,noteLength] of [[262143,261990],[262144,261991],[262145,261992],[262183,262030]])
test(`HTTP sparse tombstone accepts a ${envelopeBytes}-byte approval envelope`,async()=>{
  const db=new LimitedD1(),note='x'.repeat(noteLength);
  try {
    // Includes the row wrapper, touched fields and surrounding array brackets.
    expect(bytes([{row:{id:'r',note,updated_at:stamp,deleted_at:stamp},touched:['id','updated_at','deleted_at']}])).toBe(envelopeBytes);
    const push=await fixture(db,note),response=await push(tombstone());
    expect(await response.json()).toMatchObject({upserted:1,rejected:[]});
    expect(response.status).toBe(200);
    expect(await db.prepare('SELECT note,updated_at,deleted_at FROM items').first()).toEqual({note,updated_at:stamp,deleted_at:stamp});
    expect((await db.prepare('SELECT id FROM history').all()).results).toEqual([{id:'original'}]);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).results).toEqual([]);
  } finally {await db.close();}
});

test('large native approval cells still enforce touched dynamic options',async()=>{
  const db=new LimitedD1();
  try {
    const push=await fixture(db,'\n'.repeat(1_050_000));
    await db.prepare('ALTER TABLE items ADD COLUMN choice TEXT').run();
    await db.prepare('ALTER TABLE items ADD COLUMN alias TEXT').run();
    await db.prepare("UPDATE items SET alias='r'").run();
    await db.prepare('CREATE TABLE catalog_properties(id TEXT,tbl TEXT,col TEXT,type TEXT,sort INTEGER,options_sql TEXT,deleted_at TEXT)').run();
    await db.prepare("INSERT INTO catalog_properties VALUES('choice','items','choice','select',0,?,NULL)").bind("SELECT 'allowed' AS choice").run();
    const response=await push({table:'items',columns:['id','updated_at','choice'],rows:[{id:'r',updated_at:stamp,choice:'forbidden'}]});
    expect(await response.json()).toMatchObject({upserted:0,rejected:[{id:'r',col:'choice',rule:'options'}]});
    expect(response.status).toBe(200);
    expect(await db.prepare('SELECT choice,updated_at FROM items').first()).toEqual({choice:null,updated_at:before});
    expect((await db.prepare('SELECT id FROM history').all()).results).toEqual([]);
  } finally {await db.close();}
});

for(const constrained of [false,true])test(`large read snapshots retain binary equality, multiplicity and native REALs with constrained bindings=${constrained}`,async()=>{
  const db=new LimitedD1();
  try {
    await db.prepare('CREATE TABLE samples(label TEXT COLLATE NOCASE,n REAL,payload TEXT)').run();
    for(let i=0;i<100;i++)await db.prepare('INSERT INTO samples VALUES(?,?,?)')
      .bind(i%2?'other':'case',i%2?-1.0000000000000002:0.10000000000000003,'x'.repeat(30000)).run();
    const args=constrained?Array(94).fill(0):[];
    const sql='SELECT * FROM samples'+(constrained?' WHERE '+Array(47).fill('? IS ?').join(' AND '):'');
    const view=checkedReads(db);await view.prepare(sql).bind(...args).all();
    await db.batch(readGuards(db,view.reads));
    await db.prepare("INSERT INTO samples VALUES('extra',3.5,'new')").run();
    await expect(db.batch(readGuards(db,view.reads))).rejects.toThrow('integer overflow');
    await db.prepare("DELETE FROM samples WHERE label='extra'").run();
    for(const [change,restore] of [
      ["UPDATE samples SET label='CASE' WHERE rowid=1","UPDATE samples SET label='case' WHERE rowid=1"],
      ["UPDATE samples SET label='other',n=-1.0000000000000002 WHERE rowid=1","UPDATE samples SET label='case',n=0.10000000000000003 WHERE rowid=1"],
      ['UPDATE samples SET n=0.10000000000000005 WHERE rowid=1','UPDATE samples SET n=0.10000000000000003 WHERE rowid=1'],
    ]){
      await db.prepare(change).run();
      await expect(db.batch(readGuards(db,view.reads))).rejects.toThrow('integer overflow');
      await db.prepare(restore).run();
    }
    await db.prepare('DELETE FROM samples WHERE rowid=1').run();
    await expect(db.batch(readGuards(db,view.reads))).rejects.toThrow('integer overflow');
  } finally {await db.close();}
});

test('bulk sparse pushes bound approval snapshots while preserving every unchanged cell',async()=>{
  const db=new LimitedD1();
  try {
    const push=await fixture(db),note='x'.repeat(30000),rows=[];
    for(let i=0;i<80;i++){
      const id='row'+i;
      await db.prepare('INSERT INTO items VALUES(?,?,?,NULL,NULL)').bind(id,note,before).run();
      rows.push({id,deleted_at:stamp,updated_at:stamp});
    }
    const response=await push({table:'items',columns:['id','deleted_at','updated_at'],rows});
    expect(await response.json()).toMatchObject({upserted:80,rejected:[]});
    expect(response.status).toBe(200);
    expect(await db.prepare('SELECT count(*) AS n FROM items WHERE note=? AND deleted_at=? AND updated_at=?').bind(note,stamp,stamp).first()).toEqual({n:80});
  } finally {await db.close();}
});

test('read guards over more distinct REALs than one bind budget stay within D1 compound SELECT terms',async()=>{
  const db=new LimitedD1();
  try {
    await db.prepare('CREATE TABLE samples(n REAL)').run();
    for(let i=0;i<120;i++)await db.prepare('INSERT INTO samples VALUES(?)').bind(i+0.5).run();
    const view=checkedReads(db);await view.prepare('SELECT * FROM samples').all();
    await db.batch(readGuards(db,view.reads));
    await db.prepare('UPDATE samples SET n=0.25 WHERE rowid=1').run();
    await expect(db.batch(readGuards(db,view.reads))).rejects.toThrow('integer overflow');
  } finally {await db.close();}
});

test('chunked snapshots preserve a REAL that Bun SQLite JSON rounds by one ULP',async()=>{
  const db=new D1Shim();
  try {
    db.db.exec('CREATE TABLE samples(n REAL,payload TEXT)');
    for(const n of [2.08403533043113e+242,5e-324])db.db.query('INSERT INTO samples VALUES(?,?)').run(n,'x'.repeat(150000));
    const view=checkedReads(db);await view.prepare('SELECT * FROM samples').all();
    await db.batch(readGuards(db,view.reads));
    db.db.exec('UPDATE samples SET n=2.0840353304311298e+242 WHERE rowid=1');
    await expect(db.batch(readGuards(db,view.reads))).rejects.toThrow('integer overflow');
  } finally {db.db.close();}
});

test('a native row exceeding the remaining bind budget fails before constructing an unsafe guard',async()=>{
  const db=new LimitedD1();
  try {
    await db.prepare('CREATE TABLE samples(a TEXT,b TEXT)').run();
    await db.prepare('INSERT INTO samples VALUES(?,?)').bind('x'.repeat(300000),'small').run();
    const view=checkedReads(db);
    await view.prepare('SELECT * FROM samples WHERE '+Array(49).fill('? IS ?').join(' AND ')).bind(...Array(98).fill(0)).all();
    expect(()=>readGuards(db,view.reads)).toThrow('life_write_budget');
  } finally {await db.close();}
});
