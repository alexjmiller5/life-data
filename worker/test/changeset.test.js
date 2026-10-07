import {expect,test} from 'bun:test';
import {D1Shim} from './d1shim.js';
import * as changesets from '../src/changeset.js';
const before='2020-01-01T00:00:00.000Z';
const revision={updated_at:before,hub_at:null};
function fixture(){
  const db=new D1Shim();
  db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,label TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,immutable INTEGER,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,sql TEXT,deleted_at TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO items VALUES('old','keep','${before}',NULL,NULL);`);
  const authorize=async(_view,table)=>{if(table!=='items')throw new Error('unauthorized');};
  return {db,authorize};
}
const create={kind:'create',table:'items',id:'new',values:{label:'new'},expected_revision:null};
const patch={kind:'patch',table:'items',id:'old',values:{label:'changed'},expected_revision:revision};
const remove={kind:'soft_delete',table:'items',id:'old',expected_revision:revision};

test('bounded plans create and patch together with exact receipts, guards, and preserved history',async()=>{
  const {db,authorize}=fixture();try{
    const plan=await changesets.prepareChangeset(db,[create,patch],{authorize});
    const result=await changesets.commitChangeset(plan);
    expect(result.rows.map(r=>[r.table,r.id,r.kind])).toEqual([['items','new','create'],['items','old','patch']]);
    expect(result.rows.every(r=>r.revision.updated_at>before && r.revision.hub_at)).toBe(true);
    expect(db.db.query('SELECT label FROM items WHERE id=?').get('old').label).toBe('changed');
    expect(db.db.query('SELECT col,old,new FROM history').all()).toEqual([{col:'label',old:'keep',new:'changed'}]);
  }finally{db.db.close();}
});

for(const operation of [
  {...create,id:'old'},
  {...patch,expected_revision:{...revision,hub_at:before}},
  {...patch,values:{id:'other'}},
  {...patch,table:'history'},
  {...remove,values:{label:'changed'}},
  {...create,values:{deleted_at:before}},
])test(`invalid or stale ${JSON.stringify(operation)} writes nothing`,async()=>{
  const {db,authorize}=fixture();try{
    const original=db.db.serialize();
    await expect(changesets.prepareChangeset(db,[operation],{authorize})).rejects.toThrow();
    expect(db.db.serialize()).toEqual(original);
  }finally{db.db.close();}
});

test('duplicate operation identities, missing authorization, and bound overflow fail before reads',async()=>{
  const db={prepare(){throw new Error('unexpected read');}};
  for(const ops of [[patch,remove],Array.from({length:65},(_,i)=>({...create,id:String(i)}))])
    await expect(changesets.prepareChangeset(db,ops,{authorize:async()=>{}})).rejects.toThrow('invalid_changeset');
  await expect(changesets.prepareChangeset(db,[create])).rejects.toThrow('invalid_changeset');
});

test('concurrent target changes and same-id creates reject the whole prepared set',async()=>{
  for(const race of ["UPDATE items SET label='concurrent' WHERE id='old'",`INSERT INTO items VALUES('new','concurrent','${before}',NULL,NULL)`]){
    const {db,authorize}=fixture();try{
      const plan=await changesets.prepareChangeset(db,[create,patch],{authorize});db.db.exec(race);
      const original=db.db.serialize();await expect(changesets.commitChangeset(plan)).rejects.toThrow();
      expect(db.db.serialize()).toEqual(original);
    }finally{db.db.close();}
  }
});

test('explicit soft delete preserves source fields and refuses later resurrection',async()=>{
  const {db,authorize}=fixture();try{
    const result=await changesets.commitChangeset(await changesets.prepareChangeset(db,[remove],{authorize}));
    const row=db.db.query('SELECT * FROM items').get();expect(row.label).toBe('keep');expect(row.deleted_at).toBe(result.rows[0].revision.updated_at);
    await expect(changesets.prepareChangeset(db,[create].map(o=>({...o,id:'old'})),{authorize})).rejects.toThrow();
    await expect(changesets.prepareChangeset(db,[{...patch,expected_revision:result.rows[0].revision}],{authorize})).rejects.toThrow();
  }finally{db.db.close();}
});

test('immutable catalog fields stay immutable and no sibling create escapes',async()=>{
  const {db,authorize}=fixture();try{
    db.db.exec("INSERT INTO catalog_properties VALUES('label','items','label','text',0,1,NULL)");
    const original=db.db.serialize();await expect(changesets.prepareChangeset(db,[create,patch],{authorize})).rejects.toThrow('validation_failed');
    expect(db.db.serialize()).toEqual(original);
  }finally{db.db.close();}
});

test('rollback-only execution has no persistent effects',async()=>{
  const {db,authorize}=fixture();try{
    const plan=await changesets.prepareChangeset(db,[create,patch],{authorize}),original=db.db.serialize();
    await changesets.commitChangeset(plan,{probe:true});expect(db.db.serialize()).toEqual(original);
  }finally{db.db.close();}
});

test('trusted service receipt failure rolls back every mutation and history cell',async()=>{
  const {db,authorize}=fixture();try{
    db.db.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY); INSERT INTO receipts VALUES(\'same\')');
    const plan=await changesets.prepareChangeset(db,[create,patch],{authorize}),original=db.db.serialize();
    await expect(changesets.commitChangeset(plan,{after:[db.prepare("INSERT INTO receipts VALUES('same')")]})).rejects.toThrow();
    expect(db.db.serialize()).toEqual(original);
  }finally{db.db.close();}
});

test('bound rejection does not silently chunk an atomic operation',async()=>{
  const {db,authorize}=fixture();try{
    const original=db.db.serialize();
    await expect(changesets.prepareChangeset(db,[{...create,values:{label:'x'.repeat(65536)}}],{authorize})).rejects.toThrow('invalid_changeset');
    expect(db.db.serialize()).toEqual(original);
  }finally{db.db.close();}
});

test('receipt revisions are captured inside the transaction before a later unrelated write',async()=>{
  const {db,authorize}=fixture();try{
    const result=await changesets.commitChangeset(await changesets.prepareChangeset(db,[create,patch],{authorize}));
    const captured=structuredClone(result);
    db.db.exec("UPDATE items SET label='later',updated_at='2099-01-01T00:00:00.000Z' WHERE id='old'");
    expect(result).toEqual(captured);expect(result.rows[1].revision.updated_at).not.toBe('2099-01-01T00:00:00.000Z');
  }finally{db.db.close();}
});

test('authenticated actor and operation link every edited cell through canonical history',async()=>{
  const {ensureEvidenceStorage}=await import('../src/governance-evidence.js');
  const {db,authorize}=fixture();try{
    await ensureEvidenceStorage(db);
    const actor={principalId:'synthetic-user',kind:'user'};
    const plan=await changesets.prepareChangeset(db,[create,patch],{authorize,actor,operationId:'synthetic-operation'});
    await changesets.commitChangeset(plan);
    const events=db.db.query('SELECT h.id,g.event_id,g.actor_json,g.operation_id FROM history h JOIN _governance_history g ON g.event_id=h.id').all();
    expect(events.length).toBe(1);expect(events[0]).toMatchObject({actor_json:JSON.stringify(actor),operation_id:'synthetic-operation'});
  }finally{db.db.close();}
});

test('maximum row count commits in one batch without implicit chunks',async()=>{
  const {db,authorize}=fixture();try{
    const operations=Array.from({length:64},(_,i)=>({...create,id:'new'+i}));
    let batches=0;const batch=db.batch.bind(db);db.batch=statements=>{batches++;return batch(statements);};
    const plan=await changesets.prepareChangeset(db,operations,{authorize});expect(batches).toBe(0);
    const result=await changesets.commitChangeset(plan);expect(batches).toBe(1);expect(result.rows.length).toBe(64);
    expect(db.db.query('SELECT count(*) n FROM items').get().n).toBe(65);
  }finally{db.db.close();}
});

test('table case aliases cannot bypass the canonical catalog and immutability',async()=>{
  const {db}=fixture();try{
    db.db.exec("INSERT INTO catalog_properties VALUES('label','items','label','text',0,1,NULL)");
    const original=db.db.serialize();
    await expect(changesets.prepareChangeset(db,[{...patch,table:'ITEMS'}],{authorize:async()=>{}})).rejects.toThrow();
    expect(db.db.serialize()).toEqual(original);
  }finally{db.db.close();}
});

test('real SQLite D1 bounds preserve the maximum-sized atomic row set',async()=>{
  const {LimitedD1}=await import('./limited-d1.js');
  const db=new LimitedD1();try{
    await db.prepare('CREATE TABLE items(id TEXT PRIMARY KEY,label TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)').run();
    const authorize=async()=>{};
    const operations=Array.from({length:64},(_,i)=>({...create,id:'bounded'+i}));
    const result=await changesets.commitChangeset(await changesets.prepareChangeset(db,operations,{authorize}));
    expect(result.rows.length).toBe(64);expect((await db.prepare('SELECT count(*) n FROM items').first()).n).toBe(64);
  }finally{await db.close();}
});
