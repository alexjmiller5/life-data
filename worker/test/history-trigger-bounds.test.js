import {expect,test} from 'bun:test';
import hub from '../src/index.js';
import {D1Shim} from './d1shim.js';
import {ensureEvidenceStorage,inverseEvidence} from '../src/governance-evidence.js';
import {checkedReads} from '../src/write.js';
import {planSelectedInverse} from '../../core/src/governance.ts';

const before='2025-01-01T00:00:00.000Z',after='2025-01-02T00:00:00.000Z';
async function fixture(){
  const db=new D1Shim();
  const fields=Array.from({length:18},(_,i)=>`field_${i}`);
  db.db.exec(`CREATE TABLE records(id TEXT PRIMARY KEY,${fields.map(c=>`${c} TEXT`).join(',')},updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO records(id,${fields.join(',')},updated_at) VALUES ('row-1',${fields.map(()=>"'before'").join(',')},'${before}');
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);`);
  await ensureEvidenceStorage(db);
  const env={DB:db,AUTH_DB:new D1Shim(),HUB_TOKEN:'operator'};
  const push=async(row,history=[])=>{
    const pending=[];
    const response=await hub.fetch(new Request('https://hub.test/v1/rows/push',{method:'POST',headers:{Authorization:'Bearer operator','Content-Type':'application/json'},body:JSON.stringify({table:'records',columns:Object.keys(row),rows:[row],history})}),env,{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);
    return {status:response.status,body:await response.json()};
  };
  const helpers=()=>db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all();
  const close=()=>{db.db.close();env.AUTH_DB.db.close();};
  return {db,fields,push,helpers,close};
}

test('one wide-row tombstone with originating history fits statement limits and preserves its original event',async()=>{
  const f=await fixture();
  try{
    const event={id:'original-event',tbl:'records',row_id:'row-1',col:'deleted_at',old:null,new:after,origin:'synthetic-device',created_at:after,updated_at:after};
    const r=await f.push({id:'row-1',deleted_at:after,updated_at:after},[event]);
    expect(r.status).toBe(200);expect(r.body.rejected).toEqual([]);expect(r.body.upserted).toBe(1);
    const row=f.db.db.query('SELECT * FROM records').get();
    expect(row.deleted_at).toBe(after);expect(row.updated_at).toBe(after);
    for(const c of f.fields)expect(row[c]).toBe('before');
    const history=f.db.db.query('SELECT * FROM history').all();
    expect(history).toHaveLength(1);expect(history[0]).toMatchObject(event);
    expect(f.helpers()).toEqual([]);
  }finally{f.close();}
});

test('all changed fields across history statement boundaries retain typed evidence and a complete inverse chain',async()=>{
  const f=await fixture();
  try{
    const changes=Object.fromEntries(f.fields.map(c=>[c,'after']));
    const r=await f.push({id:'row-1',...changes,updated_at:after});
    expect(r.body.rejected).toEqual([]);
    const history=f.db.db.query('SELECT * FROM history').all();
    expect(history).toHaveLength(18);
    expect(new Set(history.map(e=>e.col))).toEqual(new Set(f.fields));
    expect(history.every(e=>e.old==='before' && e.new==='after')).toBe(true);
    expect(f.db.db.query('SELECT count(*) AS n FROM _governance_history').get().n).toBe(18);
    const revision=f.db.db.query('SELECT updated_at,hub_at FROM records').get();
    const target={table:'records',rowId:'row-1'},eventIds=history.map(e=>e.id);
    const plan=planSelectedInverse({target,eventIds},await inverseEvidence(checkedReads(f.db),target,revision,eventIds));
    expect(plan.conflicts).toEqual([]);expect(plan.changes).toHaveLength(18);
    expect(plan.changes.every(c=>c.before.value==='after' && c.after.value==='before')).toBe(true);
    expect(f.helpers()).toEqual([]);
  }finally{f.close();}
});

test('late failure rolls back wide-row changes, every history chunk and typed evidence together',async()=>{
  const f=await fixture();
  try{
    const batch=f.db.batch.bind(f.db);
    f.db.batch=async statements=>{
      // Fail after actual history insertion, inside the same SQLite transaction.
      const originals=statements.map(s=>s.run);
      let fired=false;
      for(const s of statements){const run=s.run;s.run=async()=>{
        const result=await run();
        if(!fired && f.db.db.query('SELECT count(*) AS n FROM history').get().n>0){fired=true;throw new Error('synthetic late transaction failure');}
        return result;
      };}
      try{return await batch(statements);}finally{statements.forEach((s,i)=>s.run=originals[i]);}
    };
    const r=await f.push({id:'row-1',...Object.fromEntries(f.fields.map(c=>[c,'after'])),updated_at:after});
    expect(r.status).toBe(500);
    expect(f.db.db.query('SELECT field_0,field_17,updated_at FROM records').get()).toEqual({field_0:'before',field_17:'before',updated_at:before});
    expect(f.db.db.query('SELECT * FROM history').all()).toEqual([]);
    expect(f.db.db.query('SELECT * FROM _governance_history').all()).toEqual([]);
    expect(f.helpers()).toEqual([]);
  }finally{f.close();}
});
