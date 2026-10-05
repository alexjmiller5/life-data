import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sync } from '../src/sync.ts';
import { writeRow } from '../src/write.ts';
import { setup, T0, T1 } from './support.ts';

test('candidate payloads cross the driver boundary in bounded batches without echoing pulls', async () => {
  const {db,hub,remote}=setup();
  try {
    await sync(db,hub);
    const stamp=new Date(Date.now()+10).toISOString();
    for(let i=0;i<601;i++) await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',[String(i),'Frozen',stamp]);
    remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('remote','Not a candidate',T0,T1);
    let largest=0;
    const all=db.all.bind(db);
    db.all=async (sql,params)=>{
      const rows=await all(sql,params);
      if(rows.some(row=>Object.hasOwn(row,'name') || Object.hasOwn(row,'payload'))) largest=Math.max(largest,rows.length);
      return rows;
    };
    await sync(db,hub);
    expect(largest).toBeLessThanOrEqual(200);
    expect(remote.db.query('SELECT count(*) AS n FROM items').get()).toEqual({n:602});
  } finally { db.db.close();remote.db.close(); }
});

test('snapshot SQL copies bounded batches inside one transaction with collated keysets', async () => {
  const {db,hub,remote}=setup();
  try {
    await sync(db,hub);
    await db.run('DROP TABLE items');
    await db.run('CREATE TABLE items(id TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT) WITHOUT ROWID');
    const stamp=new Date(Date.now()+10).toISOString();
    for(let i=0;i<4101;i++) await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',[`${i%2?'a':'B'}${String(i).padStart(5,'0')}`,'Frozen',stamp]);
    let largestCopy=0, copies=0;
    const run=db.run.bind(db);
    db.run=async (sql,params)=>{
      const count=await run(sql,params);
      if(sql.startsWith('INSERT INTO main._core_sync_snapshot')) {
        largestCopy=Math.max(largestCopy,count);copies++;
        expect(db.db.inTransaction).toBe(true);
      }
      return count;
    };
    await sync(db,hub);
    expect(largestCopy).toBeLessThanOrEqual(1000);
    expect(copies).toBeGreaterThan(4);
    expect(remote.db.query('SELECT count(*) AS n FROM items').get()).toEqual({n:4101});
  } finally { db.db.close();remote.db.close(); }
});

test('later candidate batches retain frozen payload and history after a concurrent edit', async () => {
  const {db,hub,remote}=setup();
  try {
    remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.name','items','name','text',T0,T1);
    await sync(db,hub);
    const stamp=new Date(Date.now()+10).toISOString();
    for(let i=0;i<601;i++) await db.run('INSERT INTO items(id,name,created_at,updated_at) VALUES (?,?,?,?)',[String(i).padStart(3,'0'),'Frozen',stamp,stamp]);
    let changed=false;
    await sync(db,{...hub,async post(route,body) {
      if(route==='/v1/rows/push' && body.table==='items' && !changed) {
        changed=true;
        await writeRow(db,'items',{id:'600',name:'Newer'});
      }
      return hub.post(route,body);
    }});
    expect(remote.db.query("SELECT name FROM items WHERE id='600'").get()).toEqual({name:'Frozen'});
    expect(remote.db.query("SELECT id FROM history WHERE row_id='600'").all()).toEqual([]);
    expect(await db.all("SELECT row_id FROM _core_pending WHERE row_id='600'")).toEqual([{row_id:'600'}]);
    await sync(db,hub);
    expect(remote.db.query("SELECT name FROM items WHERE id='600'").get()).toEqual({name:'Newer'});
    expect(remote.db.query("SELECT new FROM history WHERE row_id='600'").all()).toEqual([{new:'Newer'}]);
  } finally { db.db.close();remote.db.close(); }
});

test('failed rounds clear frozen payloads and startup discards an abandoned snapshot after reopen', async () => {
  const dir=mkdtempSync(join(tmpdir(),'life-snapshot-'));
  const {db,hub,remote}=setup();
  const path=join(dir,'replica.db');
  db.db.close();db.db=new Database(path);
  try {
    await sync(db,hub);
    await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['a','Frozen',new Date(Date.now()+10).toISOString()]);
    await expect(sync(db,{...hub,async post(route,body) {
      if(route==='/v1/rows/pull' && body.table==='items') {
        expect((await db.all('SELECT count(*) AS n FROM _core_sync_snapshot'))[0].n).toBeGreaterThan(0);
        throw new Error('offline');
      }
      return hub.post(route,body);
    }})).rejects.toThrow('offline');
    expect(await db.all('SELECT count(*) AS n FROM _core_sync_snapshot')).toEqual([{n:0}]);
    await db.run("INSERT INTO _core_sync_snapshot(kind,tbl,row_id,payload) VALUES ('row','items','abandoned','{}')");
    db.db.close();db.db=new Database(path);
    await sync(db,{...hub,async post(route,body) {
      if(route==='/v1/schema/pull') expect(await db.all('SELECT count(*) AS n FROM _core_sync_snapshot')).toEqual([{n:0}]);
      return hub.post(route,body);
    }});
    expect(remote.db.query('SELECT id FROM items').all()).toEqual([{id:'a'}]);
    expect(await db.all('SELECT count(*) AS n FROM _core_sync_snapshot')).toEqual([{n:0}]);
  } finally {db.db.close();remote.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('an unexpected snapshot object is never adopted or cleared', async () => {
  const {db,hub,remote}=setup();
  try {
    await db.run('CREATE TABLE _core_sync_snapshot (preserve TEXT)');
    await db.run("INSERT INTO _core_sync_snapshot VALUES ('untouched')");
    await expect(sync(db,hub)).rejects.toThrow('unexpected schema');
    expect(await db.all('SELECT * FROM _core_sync_snapshot')).toEqual([{preserve:'untouched'}]);
  } finally {db.db.close();remote.db.close();}
});

test('a TEMP name collision cannot redirect snapshot cleanup or payload access', async () => {
  const {db,hub,remote}=setup();
  try {
    await sync(db,hub);
    await db.run("INSERT INTO main._core_sync_snapshot(kind,tbl,row_id,payload) VALUES ('row','items','stale','{}')");
    await db.run('CREATE TEMP TABLE _core_sync_snapshot (preserve TEXT)');
    await db.run("INSERT INTO temp._core_sync_snapshot VALUES ('untouched')");
    await sync(db,hub);
    expect(await db.all('SELECT * FROM temp._core_sync_snapshot')).toEqual([{preserve:'untouched'}]);
    expect(await db.all('SELECT count(*) AS n FROM main._core_sync_snapshot')).toEqual([{n:0}]);
  } finally {db.db.close();remote.db.close();}
});

test('attached snapshot triggers are rejected before stale data can be deleted', async () => {
  const {db,hub,remote}=setup();
  try {
    await sync(db,hub);
    await db.run("INSERT INTO main._core_sync_snapshot(kind,tbl,row_id,payload) VALUES ('row','items','stale','{}')");
    await db.run('CREATE TABLE must_preserve(value TEXT)');
    await db.run("INSERT INTO must_preserve VALUES ('untouched')");
    await db.run('CREATE TRIGGER snapshot_side_effect AFTER DELETE ON _core_sync_snapshot BEGIN DELETE FROM must_preserve; END');
    await expect(sync(db,hub)).rejects.toThrow('unexpected triggers');
    expect(await db.all('SELECT * FROM must_preserve')).toEqual([{value:'untouched'}]);
    expect(await db.all('SELECT row_id FROM main._core_sync_snapshot')).toEqual([{row_id:'stale'}]);
  } finally {db.db.close();remote.db.close();}
});
