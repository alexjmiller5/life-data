import { expect, test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { patchChecked, preparePatch, commitPreparedPatch } from '../src/patch.js';
import { checkedReads } from '../src/write.js';
import { ensureEvidenceStorage, inverseEvidence } from '../src/governance-evidence.js';
import { planSelectedInverse } from '../../core/src/governance.ts';
import { applyPurges } from '../src/purge.js';
import { ensureReceiptStorage,receiptIdentity,receiptStatement,readReceipt } from '../src/governance-store.js';

const target={table:'items',rowId:'r'};
async function fixture(){
  const db=new D1Shim();
  db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,label TEXT,qty INTEGER,other TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO items VALUES ('r','first',1,'keep','2025-01-01T00:00:00.000Z',NULL,NULL);
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);`);
  await ensureEvidenceStorage(db);
  const revision=()=>{const r=db.db.query('SELECT updated_at,hub_at FROM items').get();return r;};
  const patch=values=>patchChecked(db,{table:'items',id:'r',values,expected_revision:revision()});
  const events=()=>db.db.query('SELECT * FROM history ORDER BY rowid').all();
  const evidence=ids=>inverseEvidence(checkedReads(db),target,revision(),ids);
  const plan=async ids=>planSelectedInverse({target,eventIds:ids},await evidence(ids));
  return {db,patch,events,plan,evidence};
}

test('actual checked writer records typed canonical event evidence and preserves unrelated later fields',async()=>{
  const {db,patch,events,plan}=await fixture();
  expect(await patch({label:'second',qty:2})).not.toBeInstanceOf(Response);
  const ids=events().map(e=>e.id);
  await patch({other:'later'});
  const inverse=await plan(ids);
  expect(inverse.conflicts).toEqual([]);
  expect(inverse.changes).toEqual([
    {column:'label',before:{type:'text',value:'second'},after:{type:'text',value:'first'}},
    {column:'qty',before:{type:'integer',value:'2'},after:{type:'integer',value:'1'}},
  ]);
  expect(db.db.query('SELECT other FROM items').get().other).toBe('later');
  db.db.close();
});

test('later same-column value cycle is visible even when current value matches the selected event',async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});
  const selected=events()[0].id;
  await patch({label:'third'});await patch({label:'second'});
  const inverse=await plan([selected]);
  expect(inverse.changes).toEqual([]);
  expect(inverse.conflicts[0].code).toBe('later_column_change');
  db.db.close();
});

for(const mutation of ["DELETE FROM history WHERE id=?","UPDATE history SET old='forged' WHERE id=?"])
test('removed or modified intermediate history cannot silently shorten the inverse chain: '+mutation,async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});
  const selected=events()[0].id;
  await patch({label:'third'});const middle=events()[1].id;
  db.db.query(mutation).run(middle);
  await patch({label:'fourth'});
  const inverse=await plan([selected]);
  expect(inverse.changes).toEqual([]);expect(inverse.conflicts[0].code).toBe('history_unavailable');
  db.db.close();
});

test('unverified imported history breaks prior continuity; new known events can establish a fresh boundary',async()=>{
  const {db,patch,events,plan,evidence}=await fixture();await patch({label:'second'});
  const selected=events()[0].id;
  db.db.exec("INSERT INTO history VALUES ('legacy','items','r','label','x','y','claimed','2020','2020',NULL,NULL)");
  expect((await evidence([selected])).complete).toBe(false);
  expect((await plan([selected])).conflicts[0].code).toBe('history_unavailable');
  await patch({label:'third'});
  const newest=events().at(-1).id;
  expect((await plan([newest])).changes).toEqual([{column:'label',before:{type:'text',value:'third'},after:{type:'text',value:'second'}}]);
  expect((await plan(['legacy'])).conflicts[0].code).toBe('history_unavailable');
  db.db.close();
});

test('evidence and head pointers roll back with a rejected write',async()=>{
  const {db,patch,events}=await fixture();
  db.db.exec("CREATE TRIGGER reject_update AFTER UPDATE ON items BEGIN SELECT RAISE(ABORT,'life_invariant_test'); END");
  expect(await patch({label:'second'})).toBeInstanceOf(Response);
  expect(events()).toEqual([]);
  expect(db.db.query('SELECT * FROM _governance_history').all()).toEqual([]);
  expect(db.db.query('SELECT * FROM _governance_heads').all()).toEqual([]);
  db.db.close();
});

test('missing invalidation trigger makes retained evidence unavailable before trusting its continuity',async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});
  const selected=events()[0].id;
  db.db.exec('DROP TRIGGER _governance_history_insert');
  db.db.exec("INSERT INTO history VALUES ('untracked','items','r','label','third','second','claimed','2025','2025',NULL,NULL)");
  expect((await plan([selected])).conflicts[0].code).toBe('history_unavailable');
  db.db.close();
});

test('prepared patch probe rolls back row, history, evidence and all transient helpers',async()=>{
  const {db,events}=await fixture();
  const before=db.db.serialize();
  const plan=await preparePatch(db,{table:'items',id:'r',values:{qty:2},expected_revision:{updated_at:'2025-01-01T00:00:00.000Z',hub_at:null}});
  expect(plan).not.toBeInstanceOf(Response);
  expect(await commitPreparedPatch(plan,{probe:true})).toBeNull();
  expect(events()).toEqual([]);
  expect(db.db.query('SELECT qty FROM items').get().qty).toBe(1);
  expect(db.db.query('SELECT * FROM _governance_history').all()).toEqual([]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
  expect(db.db.serialize()).toEqual(before);
  db.db.close();
});

test('canonical purge erases typed evidence and receipt payloads while excluding late retries',async()=>{
  const {db,patch,events}=await fixture();await patch({label:'second'});
  const id=events()[0].id;
  await ensureReceiptStorage(db);
  const identity=await receiptIdentity({deploymentId:'deployment',principalId:'principal',operation:'approveProposal',idempotencyKey:'key'},{proposalId:'p'});
  const statement=()=>receiptStatement(db,identity,target,['label'],200,'SELECT ? AS result',[JSON.stringify({kind:'success',value:{private:'original'}})]);
  await db.batch([statement()]);
  await applyPurges(db,[{tbl:'items',row_id:'r',col:'label',purged_at:'2099-01-01T00:00:00.000Z'}]);
  expect(events()).toEqual([]);
  expect(db.db.query('SELECT * FROM _governance_history WHERE event_id=?').all(id)).toEqual([]);
  expect((await readReceipt(db,identity)).result).toEqual({kind:'purged'});
  await expect(db.batch([statement()])).rejects.toThrow();
  db.db.close();
});

test('signed 64-bit integer evidence and conditional patches never round through JavaScript numbers',async()=>{
  const {db,patch,events,plan}=await fixture();
  db.db.exec('UPDATE items SET qty=9223372036854775807');
  expect(await patch({label:'second'})).not.toBeInstanceOf(Response);
  expect(db.db.query('SELECT CAST(qty AS TEXT) AS value FROM items').get().value).toBe('9223372036854775807');
  expect(await patch({qty:'-9223372036854775808'})).not.toBeInstanceOf(Response);
  const id=events().find(e=>e.col==='qty').id;
  const inverse=await plan([id]);
  expect(inverse.conflicts).toEqual([]);
  expect(inverse.changes).toEqual([{column:'qty',before:{type:'integer',value:'-9223372036854775808'},after:{type:'integer',value:'9223372036854775807'}}]);
  expect(await patch({qty:inverse.changes[0].after.value})).not.toBeInstanceOf(Response);
  expect(db.db.query('SELECT CAST(qty AS TEXT) AS value FROM items').get().value).toBe('9223372036854775807');
  db.db.close();
});

test('writer metadata links canonical IDs to authenticated actor and operation inside the commit',async()=>{
  const {db,events,plan}=await fixture();
  const actor={principalId:'verified-principal',kind:'user'};
  const prepared=await preparePatch(db,{table:'items',id:'r',values:{label:'second'},expected_revision:{updated_at:'2025-01-01T00:00:00.000Z',hub_at:null}},null,{actor,operationId:'operation'});
  expect(await commitPreparedPatch(prepared)).not.toBeInstanceOf(Response);
  const metadata=db.db.query('SELECT event_id,actor_json,operation_id FROM _governance_history').get();
  expect(metadata).toEqual({event_id:events()[0].id,actor_json:JSON.stringify(actor),operation_id:'operation'});
  expect((await plan([metadata.event_id])).conflicts).toEqual([]);
  db.db.close();
});

test('changing retained history after planning prevents commit through the shared read guards',async()=>{
  const {db,patch,events}=await fixture();await patch({label:'second'});
  const rev=db.db.query('SELECT updated_at,hub_at FROM items').get(),id=events()[0].id;
  const view=checkedReads(db);
  await inverseEvidence(view,target,rev,[id]);
  const prepared=await preparePatch(db,{table:'items',id:'r',values:{label:'first'},expected_revision:rev},null,{view});
  db.db.query("UPDATE history SET old='changed' WHERE id=?").run(id);
  const result=await commitPreparedPatch(prepared);
  expect(result).toBeInstanceOf(Response);expect(result.status).toBe(409);
  expect(db.db.query('SELECT label FROM items').get().label).toBe('second');
  db.db.close();
});

for(const sql of [
  "UPDATE items SET label='third'; UPDATE items SET label='second'",
  "UPDATE items SET deleted_at='deleted'; UPDATE items SET deleted_at=NULL",
  "INSERT OR REPLACE INTO items SELECT * FROM items",
  "DELETE FROM items; INSERT INTO items VALUES ('r','second',1,'keep','2025-01-01T00:00:00.000Z',NULL,NULL)",
])test('untracked row mutation cannot retain the old inverse chain: '+sql,async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});const id=events()[0].id;
  db.db.exec(sql);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  expect(db.db.query('SELECT * FROM _governance_writes').all()).toEqual([]);
  db.db.close();
});

test('reinstalling missing guards permanently breaks old continuity and token bindings',async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});const id=events()[0].id;
  const old=db.db.query("SELECT version FROM _governance_invalidations WHERE tbl='items' AND row_id='r'").get().version;
  const guard=db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_governance_rows_*_update'").get().name;
  db.db.exec(`DROP TRIGGER "${guard}"; UPDATE items SET label='third'; UPDATE items SET label='second'`);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  await ensureEvidenceStorage(db);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  expect(db.db.query("SELECT version FROM _governance_invalidations WHERE tbl='items' AND row_id='r'").get().version).not.toBe(old);
  await patch({label:'fresh'});
  expect((await plan([events().at(-1).id])).conflicts).toEqual([]);
  db.db.close();
});

test('dropping and recreating an identical table cannot reuse retained evidence',async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});const id=events()[0].id;
  const ddl=db.db.query("SELECT sql FROM sqlite_master WHERE name='items'").get().sql;
  db.db.exec(`DROP TABLE items; ${ddl}; INSERT INTO items VALUES ('r','second',1,'keep','2025-01-01T00:00:00.000Z',NULL,NULL)`);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  await ensureEvidenceStorage(db);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  db.db.close();
});

test('a custom target trigger cannot create a trusted writer context or reusable typed chain',async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});const id=events()[0].id;
  db.db.exec("CREATE TRIGGER target_cycle AFTER UPDATE OF other ON items BEGIN UPDATE items SET label='third'; UPDATE items SET label='second'; END");
  const prepared=await preparePatch(db,{table:'items',id:'r',values:{other:'later'},expected_revision:db.db.query('SELECT updated_at,hub_at FROM items').get()});
  expect(prepared.log.evidence).toBe(false);
  db.db.exec("UPDATE items SET other='later'; DROP TRIGGER target_cycle");
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  expect(db.db.query('SELECT * FROM _governance_writes').all()).toEqual([]);
  db.db.close();
});

test('REAL typed reads preserve finite extremes, subnormals and adjacent doubles; infinity stays unknown',async()=>{
  const {typedCells}=await import('../src/governance-evidence.js');
  const db=new D1Shim();db.db.exec('CREATE TABLE numbers(id TEXT PRIMARY KEY,n REAL)');
  const values=[0,0.1,1.0000000000000002,1.2345678901234567,Number.MAX_VALUE,Number.MIN_VALUE,-Number.MIN_VALUE,1e-300,-1e300];
  const bytes=new DataView(new ArrayBuffer(8));
  let state=0x123456789abcdef0n;
  for(let i=0;i<128;i++){
    state=BigInt.asUintN(64,state*6364136223846793005n+1n);bytes.setBigUint64(0,state);
    const n=bytes.getFloat64(0);if(Number.isFinite(n))values.push(n);
  }
  for(const n of values){
    db.db.query("INSERT OR REPLACE INTO numbers VALUES ('r',?)").run(n);
    expect((await typedCells(checkedReads(db),{table:'numbers',rowId:'r'},['n'])).n).toEqual({type:'real',value:n});
  }
  db.db.exec("UPDATE numbers SET n=1e999");
  expect((await typedCells(checkedReads(db),{table:'numbers',rowId:'r'},['n'])).n).toBeNull();
  db.db.close();
});

test('column renames cannot transfer a historical inverse to a different field',async()=>{
  const {db,patch,events,plan}=await fixture();db.db.exec("UPDATE items SET other='second'");
  await patch({label:'second'});const id=events()[0].id;
  db.db.exec('ALTER TABLE items RENAME COLUMN label TO archived; ALTER TABLE items RENAME COLUMN other TO label');
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  await ensureEvidenceStorage(db);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  db.db.close();
});

test('ordinary initialization excludes virtual tables from continuity guards',async()=>{
  const db=new D1Shim();db.db.exec('CREATE VIRTUAL TABLE searchable USING fts5(id,updated_at,content)');
  await ensureEvidenceStorage(db);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_governance_rows_*'").all()).toEqual([]);
  db.db.close();
});

for(const [collation,next] of [['NOCASE','SECOND'],['RTRIM','second ']])
for(const checked of [true,false])test(`storage-exact history detects ${collation} value cycles (checked=${checked})`,async()=>{
  const {db,patch,events,plan}=await fixture();
  db.db.exec(`DROP TABLE items; CREATE TABLE items(id TEXT PRIMARY KEY,label TEXT COLLATE ${collation},qty INTEGER,other TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO items VALUES ('r','first',1,'keep','2025-01-01T00:00:00.000Z',NULL,NULL)`);
  await ensureEvidenceStorage(db);
  await patch({label:'second'});const id=events()[0].id;
  if(checked){await patch({label:next});await patch({label:'second'});}
  else {db.db.query('UPDATE items SET label=?').run(next);db.db.exec("UPDATE items SET label='second'");}
  expect((await plan([id])).conflicts[0]?.code).toBe(checked?'later_column_change':'history_unavailable');
  db.db.close();
});

test('read guards preserve native REALs and detect exact collated text changes',async()=>{
  const {readGuards}=await import('../src/write.js');
  const db=new D1Shim();db.db.exec('CREATE TABLE samples(n REAL,t TEXT COLLATE NOCASE)');
  const bytes=new DataView(new ArrayBuffer(8));let state=0x123456789abcdef0n;
  for(let i=0;i<128;i++){
    state=BigInt.asUintN(64,state*6364136223846793005n+1n);bytes.setBigUint64(0,state);
    const n=bytes.getFloat64(0);if(Number.isFinite(n))db.db.query("INSERT INTO samples VALUES (?,'case')").run(n);
  }
  const view=checkedReads(db);await view.prepare('SELECT * FROM samples').all();
  await db.batch(readGuards(db,view.reads));
  db.db.exec("UPDATE samples SET t='CASE'");
  await expect(db.batch(readGuards(db,view.reads))).rejects.toThrow();
  db.db.close();
});

test('continuity guards permit ordinary user-column removal and invalidate the old layout',async()=>{
  const {db,patch,events,plan}=await fixture();await patch({label:'second'});const id=events()[0].id;
  db.db.exec('ALTER TABLE items DROP COLUMN other');
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  await ensureEvidenceStorage(db);
  expect((await plan([id])).conflicts[0]?.code).toBe('history_unavailable');
  db.db.close();
});

for(const table of ['native','actual','expected'])test('read proof helpers cannot shadow ordinary user table '+table,async()=>{
  const db=new D1Shim();
  db.db.exec(`CREATE TABLE "${table}"(id TEXT PRIMARY KEY,n REAL,label TEXT,updated_at TEXT,deleted_at TEXT);
    INSERT INTO "${table}" VALUES ('r',0.5,'before','2025-01-01T00:00:00.000Z',NULL)`);
  const result=await patchChecked(db,{table,id:'r',values:{label:'after'},expected_revision:{updated_at:'2025-01-01T00:00:00.000Z',hub_at:null}});
  expect(result).not.toBeInstanceOf(Response);
  expect(db.db.query(`SELECT label FROM "${table}"`).get().label).toBe('after');
  db.db.close();
});
