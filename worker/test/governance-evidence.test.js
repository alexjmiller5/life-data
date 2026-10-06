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
