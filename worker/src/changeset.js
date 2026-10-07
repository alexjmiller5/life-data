// Trusted service primitive, not a public mutation route or an approval grant.
// The caller supplies authorization and all displayed read/membership guards.
import {checkedReads,prepareChecked,readGuards,enforcedRules,queryBudget} from './write.js';
import {historyPlan} from './history.js';
import {ident,qident,validatePush,validEditTimestamp} from './validate.js';

export const changesetLimits=Object.freeze({maxOperations:64,maxTables:8,maxBytes:65536});
const managed=new Set(['id','created_at','updated_at','hub_at','deleted_at']);
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const text=v=>typeof v==='string' && v.length>0;
const fail=code=>{throw new Error(code);};
const exact=(value,keys)=>object(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const revision=v=>exact(v,['updated_at','hub_at']) && validEditTimestamp(v.updated_at) && (v.hub_at===null || validEditTimestamp(v.hub_at));
const plans=new WeakSet();
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function validOperations(operations){
  if(!Array.isArray(operations) || !operations.length || operations.length>changesetLimits.maxOperations)return false;
  let bytes;try{bytes=new TextEncoder().encode(JSON.stringify(operations)).length;}catch{return false;}
  if(bytes>changesetLimits.maxBytes)return false;
  const targets=new Set(),tables=new Set();
  for(const op of operations){
    if(!object(op) || !['create','patch','soft_delete'].includes(op.kind) || !text(op.id))return false;
    const keys=['kind','table','id','expected_revision',...(op.kind==='soft_delete'?[]:['values'])];
    if(!exact(op,keys) || (op.kind==='create'?op.expected_revision!==null:!revision(op.expected_revision)))return false;
    try{ident(op.table);}catch{return false;}
    // Catalog and engine control state require their own supported protocols.
    if(op.table.startsWith('_') || /^(?:sqlite_|catalog_)/i.test(op.table) || ['history','purges'].includes(op.table.toLowerCase()))return false;
    if(op.table.toLowerCase()==='provenance' && op.kind!=='create')return false;
    if(op.kind!=='soft_delete'){
      if(!object(op.values) || !Object.keys(op.values).length)return false;
      for(const [c,v] of Object.entries(op.values)){
        try{ident(c);}catch{return false;}
        if(managed.has(c.toLowerCase()) || v===undefined || typeof v==='function' || typeof v==='bigint'
          || (typeof v==='number' && !Number.isFinite(v)))return false;
      }
    }
    const key=JSON.stringify([op.table.toLowerCase(),op.id]);if(targets.has(key))return false;
    targets.add(key);tables.add(op.table.toLowerCase());
  }
  return tables.size<=changesetLimits.maxTables;
}

export async function prepareChangeset(database,operations,{authorize,view:providedView,actor=null,operationId=null}={}){
  if(!validOperations(operations) || typeof authorize!=='function')fail('invalid_changeset');
  const db=queryBudget(database,750),view=providedView ?? checkedReads(db);
  // All authorization precedes target reads, including absence disclosure.
  for(const op of operations)await authorize(view,op.table,op.kind,[op.id]);
  await view.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name").all();
  const groups=new Map(),originals=new Map(),changes=[];let millis=Date.now();
  for(const op of operations){
    let group=groups.get(op.table);
    if(!group){
      const physical=await view.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? COLLATE BINARY").bind(op.table).first();
      if(physical?.name!==op.table)fail('invalid_changeset');
      const {results:schema}=await view.prepare('SELECT * FROM pragma_table_info(?) ORDER BY cid').bind(op.table).all();
      const names=new Set(schema.map(c=>c.name));
      if(!['id','updated_at','deleted_at','hub_at'].every(c=>names.has(c)))fail('invalid_changeset');
      const {results:key}=await view.prepare("SELECT x.name,x.coll FROM pragma_index_list(?) i JOIN pragma_index_xinfo(i.name) x WHERE i.origin='pk' AND x.key=1 ORDER BY x.seqno").bind(op.table).all();
      if(schema.find(c=>c.name==='id')?.type?.toUpperCase()!=='TEXT' || key.length!==1 || key[0].name!=='id' || key[0].coll!=='BINARY')fail('invalid_changeset');
      group={table:op.table,schema,names,operations:[]};groups.set(op.table,group);
    }
    if(Object.keys(op.values ?? {}).some(c=>!group.names.has(c)))fail('invalid_changeset');
    const current=await view.prepare(`SELECT * FROM ${qident(op.table)} WHERE id=?`).bind(op.id).first();
    originals.set(JSON.stringify([op.table,op.id]),current);
    if(op.kind==='create'){if(current)fail('revision_conflict');}
    else{
      if(!current || current.id!==op.id || current.deleted_at!==null
        || current.updated_at!==op.expected_revision.updated_at || current.hub_at!==op.expected_revision.hub_at)fail('revision_conflict');
      millis=Math.max(millis,Date.parse(current.updated_at)+1);
    }
    group.operations.push(op);
  }
  const updatedAt=new Date(millis).toISOString();if(!validEditTimestamp(updatedAt))fail('invalid_changeset');
  const prepared=[];let historyInitialization=false;
  for(const group of groups.values()){
    const {table}=group;
    const proposed=group.operations.map(op=>({id:op.id,...(op.kind==='soft_delete'?{deleted_at:updatedAt}:op.values),updated_at:updatedAt}));
    const validated=await validatePush(view,table,proposed,db);
    if(validated.rejected.length || validated.expected.length!==proposed.length || validated.accepted.length!==proposed.length)fail('validation_failed');
    const {accepted,expected,props,transitions}=validated;
    const values=row=>row===null?null:Object.fromEntries(Object.entries(row).filter(([c])=>!managed.has(c)));
    for(let i=0;i<group.operations.length;i++){
      const op=group.operations[i];
      changes.push({table,id:op.id,kind:op.kind,before:values(originals.get(JSON.stringify([table,op.id]))),after:op.kind==='soft_delete'?null:values(expected[i])});
    }
    const rules=await enforcedRules(view,table),history=await historyPlan(view,db,table,accepted,[],transitions);
    if(history){
      if(!history.exists){if(historyInitialization)history.exists=true;else historyInitialization=true;}
      history.actor=actor;history.operationId=operationId;
    }
    const statements=accepted.map((row,i)=>{
      const op=group.operations[i],columns=Object.keys(row).filter(c=>c!=='hub_at');
      const values=columns.map(c=>typeof row[c]==='boolean'?Number(row[c]):typeof row[c]==='object' && row[c]!==null?JSON.stringify(row[c]):row[c]);
      if(columns.length>98)fail('invalid_changeset');
      if(op.kind==='create')return db.prepare(`INSERT INTO ${qident(table)} (${columns.map(qident).join(',')},hub_at) VALUES (${columns.map(()=>'?').join(',')},${now})`).bind(...values);
      return db.prepare(`UPDATE ${qident(table)} SET ${columns.map(c=>qident(c)+'=?').join(',')},hub_at=${now} WHERE id=?`).bind(...values,op.id);
    });
    const plan=await prepareChecked(db,table,rules,statements,updatedAt,history,expected,props,transitions,false,{finalState:true});
    // A suppressed mutation must never receive a success receipt.
    for(const op of group.operations)plan.checks.push(db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM ${qident(table)} WHERE id=? AND updated_at=?) THEN 1 ELSE abs(-9223372036854775808) END AS life_write_conflict`).bind(op.id,updatedAt));
    prepared.push(plan);
  }
  changes.sort((a,b)=>operations.findIndex(o=>o.table===a.table && o.id===a.id)-operations.findIndex(o=>o.table===b.table && o.id===b.id));
  const plan={db,view,operations:structuredClone(operations),changes,prepared,updatedAt};plans.add(plan);return plan;
}

export async function commitChangeset(plan,{after=[],probe=false}={}){
  if(!plans.has(plan))fail('invalid_changeset');
  const {db,view,prepared,operations}=plan;
  const statements=[...readGuards(db,view.reads),...prepared.flatMap(p=>p.begin),...prepared.flatMap(p=>p.statements),...prepared.flatMap(p=>p.checks)];
  const offset=statements.length;
  for(const op of operations)statements.push(db.prepare(`SELECT id,updated_at,hub_at FROM ${qident(op.table)} WHERE id=?`).bind(op.id));
  statements.push(...after,...prepared.flatMap(p=>p.end));
  if(probe){
    const key='_life_write_'+crypto.randomUUID().replaceAll('-','')+'_probe';
    statements.push(db.prepare(`CREATE TABLE ${qident(key)} (ok INTEGER CONSTRAINT life_probe_complete CHECK(ok=1))`),db.prepare(`INSERT INTO ${qident(key)} VALUES(0)`));
  }
  try{
    const result=await db.batch(statements);
    return {rows:operations.map((op,i)=>{
      const row=result[offset+i].results[0];
      return {table:op.table,id:row.id,kind:op.kind,revision:{updated_at:row.updated_at,hub_at:row.hub_at}};
    })};
  }catch(error){if(probe && String(error).includes('life_probe_complete'))return null;throw error;}
}
