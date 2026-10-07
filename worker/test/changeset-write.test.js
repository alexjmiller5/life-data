import {expect,test} from 'bun:test';
import {D1Shim} from './d1shim.js';
import {checkedReads,prepareChecked,readGuards} from '../src/write.js';
import {historyPlan} from '../src/history.js';
import {validatePush} from '../src/validate.js';

const old='2030-01-01T00:00:00.000Z',stamp='2030-01-02T00:00:00.000Z';
function fixture(){
  const db=new D1Shim();
  db.db.exec(`CREATE TABLE buckets(id TEXT PRIMARY KEY,label TEXT,note TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE entries(id TEXT PRIMARY KEY,bucket TEXT,qty INTEGER,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,deleted_at TEXT);
    INSERT INTO buckets VALUES('b','whole','preserve','${old}',NULL,NULL);
    INSERT INTO catalog_properties VALUES('entry-bucket','entries','bucket','ref',0,1,NULL,NULL,'buckets',NULL);`);
  return db;
}
const bucketRule={sql:`SELECT c.id FROM changed c WHERE c.deleted_at IS NULL AND c.label IS NOT NULL
  AND EXISTS(SELECT 1 FROM entries e WHERE e.bucket=c.id AND e.deleted_at IS NULL)`};
const entryRule={sql:`SELECT c.id FROM changed c JOIN buckets b ON b.id=c.bucket
  WHERE c.deleted_at IS NULL AND b.label IS NOT NULL`};
async function plan(db,view,table,rows,rules,mutations){
  const v=await validatePush(view,table,rows,db);
  expect(v.rejected).toEqual([]);
  const log=await historyPlan(view,db,table,v.accepted,[],v.transitions);
  return prepareChecked(db,table,rules,mutations,stamp,log,v.expected,v.props,v.transitions,false,{finalState:true});
}
async function prepareConversion(db){
  const view=checkedReads(db);
  await view.prepare('SELECT * FROM entries WHERE bucket=? AND deleted_at IS NULL ORDER BY id').bind('b').all();
  const b=await plan(db,view,'buckets',[{id:'b',label:null,updated_at:stamp}],[bucketRule],
    [db.prepare('UPDATE buckets SET label=NULL,updated_at=? WHERE id=?').bind(stamp,'b')]);
  const e=await plan(db,view,'entries',[{id:'e',bucket:'b',qty:2,updated_at:stamp}],[entryRule],
    [db.prepare('INSERT INTO entries VALUES(?,?,?,?,NULL,NULL)').bind('e','b',2,stamp)]);
  return {view,plans:[e,b]};
}
async function commit(db,{view,plans},after=[]){
  await db.batch([...readGuards(db,view.reads),...plans.flatMap(p=>p.begin),...plans.flatMap(p=>p.statements),
    ...plans.flatMap(p=>p.checks ?? []),...after,...plans.flatMap(p=>p.end)]);
}
const state=db=>db.db.serialize();

test('final-state cross-table validation accepts a valid result in either mutation order',async()=>{
  for(const reverse of [false,true]){
    const db=fixture();try{
      const prepared=await prepareConversion(db);if(reverse)prepared.plans.reverse();
      await commit(db,prepared);
      expect(db.db.query('SELECT label,note FROM buckets').get()).toEqual({label:null,note:'preserve'});
      expect(db.db.query('SELECT id,bucket,qty FROM entries').all()).toEqual([{id:'e',bucket:'b',qty:2}]);
      expect(db.db.query('SELECT col,old,new FROM history WHERE tbl=?').all('buckets')).toEqual([{col:'label',old:'whole',new:null}]);
      expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
    }finally{db.db.close();}
  }
});

test('final-state validation rejects a bad final result without persistent effects',async()=>{
  const db=fixture();try{
    const prepared=await prepareConversion(db);prepared.plans=prepared.plans.slice(0,1);
    const before=state(db);
    await expect(commit(db,prepared)).rejects.toThrow();
    expect(state(db)).toEqual(before);
  }finally{db.db.close();}
});

test('membership phantom after preparation rejects all writes and history',async()=>{
  const db=fixture();try{
    const prepared=await prepareConversion(db);
    db.db.query('INSERT INTO entries VALUES(?,?,?,?,NULL,NULL)').run('concurrent','b',1,old);
    const before=state(db);await expect(commit(db,prepared)).rejects.toThrow('integer overflow');
    expect(state(db)).toEqual(before);
  }finally{db.db.close();}
});

test('late failure rolls back complete final-state mutations and history',async()=>{
  const db=fixture();try{
    const prepared=await prepareConversion(db),before=state(db);
    await expect(commit(db,prepared,[db.prepare('SELECT abs(-9223372036854775808)')])).rejects.toThrow();
    expect(state(db)).toEqual(before);
  }finally{db.db.close();}
});

test('removing the final entries and restoring a whole label validates only the final result',async()=>{
  const db=fixture();try{
    db.db.exec(`UPDATE buckets SET label=NULL; INSERT INTO entries VALUES('e','b',2,'${old}',NULL,NULL)`);
    const view=checkedReads(db);
    const b=await plan(db,view,'buckets',[{id:'b',label:'whole',updated_at:stamp}],[bucketRule],
      [db.prepare('UPDATE buckets SET label=?,updated_at=? WHERE id=?').bind('whole',stamp,'b')]);
    const e=await plan(db,view,'entries',[{id:'e',deleted_at:stamp,updated_at:stamp}],[entryRule],
      [db.prepare('UPDATE entries SET deleted_at=?,updated_at=? WHERE id=?').bind(stamp,stamp,'e')]);
    await commit(db,{view,plans:[b,e]});
    expect(db.db.query('SELECT label,note FROM buckets').get()).toEqual({label:'whole',note:'preserve'});
    expect(db.db.query('SELECT deleted_at FROM entries').get().deleted_at).toBe(stamp);
    expect(db.db.query('SELECT count(*) n FROM history').get().n).toBe(2);
  }finally{db.db.close();}
});

for(const missing of [false,true])test(`final-state references resolve a sibling create and reject a missing reference: missing=${missing}`,async()=>{
  const db=fixture();try{
    const view=checkedReads(db);
    const e=await plan(db,view,'entries',[{id:'e',bucket:'new',qty:2,updated_at:stamp}],[],
      [db.prepare('INSERT INTO entries VALUES(?,?,?,?,NULL,NULL)').bind('e','new',2,stamp)]);
    const b=await plan(db,view,'buckets',[{id:'new',label:null,updated_at:stamp}],[],
      [db.prepare('INSERT INTO buckets VALUES(?,?,NULL,?,NULL,NULL)').bind('new',null,stamp)]);
    if(missing){const before=state(db);await expect(commit(db,{view,plans:[e]})).rejects.toThrow();expect(state(db)).toEqual(before);}
    else{await commit(db,{view,plans:[e,b]});expect(db.db.query('SELECT bucket FROM entries').get().bucket).toBe('new');}
  }finally{db.db.close();}
});

test('a final-state invariant receives the entire before and after sets with native storage types',async()=>{
  const db=fixture();try{
    db.db.exec(`INSERT INTO entries VALUES('x','b',2,'${old}',NULL,NULL); INSERT INTO entries VALUES('y','b',3,'${old}',NULL,NULL)`);
    const view=checkedReads(db),rule={sql:`SELECT 1 WHERE (SELECT sum(qty) FROM changed)!=(SELECT sum(qty) FROM before)
      OR EXISTS(SELECT 1 FROM changed WHERE typeof(qty)!='integer')`};
    const p=await plan(db,view,'entries',[{id:'x',qty:4,updated_at:stamp},{id:'y',qty:1,updated_at:stamp}],[rule],
      [db.prepare('UPDATE entries SET qty=4,updated_at=? WHERE id=?').bind(stamp,'x'),
       db.prepare('UPDATE entries SET qty=1,updated_at=? WHERE id=?').bind(stamp,'y')]);
    await commit(db,{view,plans:[p]});
    expect(db.db.query('SELECT qty FROM entries ORDER BY id').all()).toEqual([{qty:4},{qty:1}]);
  }finally{db.db.close();}
});
