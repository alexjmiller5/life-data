import {prepareChangeset,commitChangeset,validOperations,changesetLimits} from './changeset.js';
import {checkedReads,readGuards,queryBudget} from './write.js';
import {configuration,seal,unseal,same} from './governance-preview.js';
import {canonical,receiptIdentity} from './governance-store.js';
import {changesetReceipt,readChangesetReceipt} from './changeset-store.js';
import {assertGenericState} from './governance-isolation.js';
import {broadTableAccess,changesetTable,ScopeDenied} from './scopes.js';
import {qident,literal,sha256hex,validEditTimestamp} from './validate.js';
import {hasContinuityGuards} from './governance-continuity.js';

export const changesetOperations=Object.fromEntries([
  ['preview',{read:true,preview:true}],['proposals/create',{}],['proposals/get',{read:true}],
  ['proposals/preview',{read:true,preview:true}],['proposals/approve',{approve:true}],['proposals/reject',{}],
].map(([name,flags])=>['/v1/governance/changesets/'+name,{name:'changeset:'+name,changeset:true,...flags}]));
export const changesetGovernanceLimits=Object.freeze({...changesetLimits,maxReadSets:64,maxMembershipRows:20000,maxReadRows:2000,previewTtlSeconds:300});
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const text=v=>typeof v==='string' && v.trim().length>0;
const exact=(x,required,optional=[])=>object(x) && required.every(k=>Object.hasOwn(x,k)) && Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const success=value=>({kind:'success',value});
const error=(code,resolution='unresolved')=>({kind:'error',code,resolution,conflicts:[]});
const fail=code=>{throw new Error(code);};
export const canChangeset=(tenant,approve=false)=>!!tenant.governance && broadTableAccess(tenant.scopes,'read')
  && (approve?tenant.governance.approve && tenant.governance.actor.kind==='user' && broadTableAccess(tenant.scopes,'write')
    :tenant.governance.propose||tenant.governance.approve);
function validInput(body){
  return exact(body,['operations','reads']) && validOperations(body.operations) && Array.isArray(body.reads) && body.reads.length<=64
    && body.reads.every(r=>exact(r,['table','where','expected']) && text(r.table) && object(r.where) && Object.keys(r.where).length>0 && Object.keys(r.where).length<=16
      && Array.isArray(r.expected) && r.expected.length<=2000 && new Set(r.expected.map(e=>e?.id)).size===r.expected.length
      && r.expected.every(e=>exact(e,['id','revision']) && text(e.id) && exact(e.revision,['updated_at','hub_at']) && validEditTimestamp(e.revision.updated_at)
        && (e.revision.hub_at===null || validEditTimestamp(e.revision.hub_at)))
      && Object.entries(r.where).every(([k,v])=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (v===null || typeof v==='string' || typeof v==='boolean' || typeof v==='number' && Number.isFinite(v))));
}
async function boundedBody(request){
  const reader=request.body?.getReader();if(!reader)fail('invalid_changeset');
  const parts=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();fail('invalid_changeset');}parts.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_changeset');}
}
function validArgs(name,b){
  if(name==='preview')return validInput(b);
  const fields=name==='proposals/create'?['previewToken','idempotencyKey']:name==='proposals/get'?['proposalId']:
    name==='proposals/preview'?['proposalId','expectedVersion']:name==='proposals/approve'?['proposalId','expectedVersion','previewToken','idempotencyKey']:['proposalId','expectedVersion','idempotencyKey'];
  return exact(b,fields,name==='proposals/create'?['claimedOrigin']:[]) && fields.every(f=>text(b[f])) && (!Object.hasOwn(b,'claimedOrigin') || typeof b.claimedOrigin==='string');
}

async function plan(db,tenant,input,actor=null,operationId=null){
  if(!validInput(input))fail('invalid_changeset');
  const view=checkedReads(db);await assertGenericState(view);
  const tables=[...new Set(input.operations.map(o=>o.table))].sort(),targets=[];
  // A conservative complete revision set guards every affected table, including
  // absent siblings. The service never trusts an incomplete client ID list.
  for(const table of tables){
    await changesetTable(view,table);
    if(table==='provenance'){
      // Evidence is insert-only. Guard the exact edge identities, not the
      // dataset's unrelated retained evidence (which can be much larger).
      for(const op of input.operations.filter(o=>o.table===table))targets.push({table,id:op.id});
      continue;
    }
    if(!await hasContinuityGuards(view,table))throw new ScopeDenied();
    const {results}=await view.prepare(`SELECT id,updated_at,hub_at,deleted_at FROM ${qident(table)} ORDER BY id LIMIT 20001`).all();
    if(results.length>20000)fail('changeset_capacity');
    const {results:invalidations}=await view.prepare('SELECT row_id,version FROM _governance_invalidations WHERE tbl=? ORDER BY row_id LIMIT 20001').bind(table).all();
    if(invalidations.length>20000)fail('changeset_capacity');
    targets.push({table,id:null});
  }
  let readRows=0;
  for(const read of input.reads){
    const schema=await changesetTable(view,read.table),entries=Object.entries(read.where).sort(([a],[b])=>a.localeCompare(b));
    if(entries.some(([c])=>!schema.some(s=>s.name===c)))fail('invalid_changeset');
    const {results}=await view.prepare(`SELECT * FROM ${qident(read.table)} WHERE ${entries.map(([c])=>qident(c)+' IS ?').join(' AND ')} ORDER BY id LIMIT 2001`)
      .bind(...entries.map(([,v])=>typeof v==='boolean'?Number(v):v)).all();
    readRows+=results.length;if(readRows>2000)fail('changeset_capacity');
    const expected=new Map(read.expected.map(e=>[e.id,e.revision]));
    if(results.length!==expected.size || results.some(r=>!expected.has(r.id) || r.updated_at!==expected.get(r.id).updated_at || r.hub_at!==expected.get(r.id).hub_at))fail('revision_conflict');
    targets.push({table:read.table,id:null});
  }
  const prepared=await prepareChangeset(db,input.operations,{view,actor,operationId,
    authorize:(v,table,_kind,ids)=>changesetTable(v,table,true,ids)});
  // References and dynamic options are captured by the checked validator. Purge
  // any proposal depending on their table rather than preserving stale content.
  for(const table of tables){
    const {results:props}=await view.prepare('SELECT ref_table,options_sql FROM catalog_properties WHERE tbl=? AND deleted_at IS NULL ORDER BY id').bind(table).all();
    for(const p of props)if(p.ref_table)targets.push({table:p.ref_table,id:null});
    if(props.some(p=>p.options_sql)){
      const {results:catalog}=await view.prepare("SELECT id FROM catalog_tables WHERE deleted_at IS NULL AND (kind IS NULL OR kind='table') ORDER BY id LIMIT 2001").all();
      if(catalog.length>2000)fail('changeset_capacity');
      for(const {id} of catalog)targets.push({table:id,id:null});
    }
  }
  await commitChangeset(prepared,{probe:true});
  const dependencies=await sha256hex(canonical([...view.reads.values()]));
  return {prepared,view,changes:prepared.changes,dependencies,targets:[...new Map(targets.map(t=>[canonical(t),t])).values()]};
}
async function preview(db,tenant,config,input,proposal=null){
  const p=await plan(db,tenant,input);
  const expiresAt=new Date(Date.now()+300000).toISOString();
  const binding={type:'changeset-preview',principal:tenant.governance.actor.principalId,input,changes:p.changes,dependencies:p.dependencies,proposal,expiresAt};
  if(new TextEncoder().encode(JSON.stringify(binding)).length>38000)fail('changeset_capacity');
  return {...p,value:{changes:p.changes,previewToken:await seal(config,binding),expiresAt}};
}
async function load(view,id){
  const row=await view.prepare('SELECT * FROM _governance_changesets WHERE id=?').bind(id).first();
  if(!row)return null;
  return {...row,proposal:row.payload?{...JSON.parse(row.payload),state:row.state,updatedAt:row.updated_at}:null};
}
async function replay(db,identity){const r=await readChangesetReceipt(db,identity);return r?reply(r.body,r.status):null;}
async function settle(db,identity,targets,status,code){
  const body=error(code,'not_committed');
  try{await db.batch([changesetReceipt(db,identity,status,targets,'SELECT ? AS result',[JSON.stringify(body)])]);}
  catch(e){const r=await replay(db,identity);if(r)return r;throw e;}
  return reply(body,status);
}
function resultSQL(operations){
  const tables=[...new Set(operations.map(o=>o.table))];
  const rows=tables.map(table=>`SELECT CAST(o.key AS INTEGER) AS position,json_object('table',${literal(table)},'id',r.id,'kind',json_extract(o.value,'$.kind'),
    'revision',json_object('updated_at',r.updated_at,'hub_at',r.hub_at)) AS value
    FROM ${qident(table)} r JOIN json_each(?1) o ON r.id=json_extract(o.value,'$.id') WHERE json_extract(o.value,'$.table')=${literal(table)}`).join(' UNION ALL ');
  return `SELECT json_object('kind','success','value',json_object('operationId',?2,'proposalId',?3,'proposalVersion',?4,
    'rows',json((SELECT json_group_array(json(value)) FROM (SELECT value FROM (${rows}) ORDER BY position))),
    'historyEventIds',json((SELECT json_group_array(event_id) FROM (SELECT event_id FROM _governance_history WHERE operation_id=?2 ORDER BY seq))),
    'approvedBy',json(?5),'committedAt',?6)) AS result`.replace(/\?(\d+)/g,(_match,n)=>'?'+(Number(n)+3));
}
export async function handleChangesetGovernance(request,tenant,env,operation){
  const name=operation.name.slice('changeset:'.length),approve=name==='proposals/approve',config=configuration(env);
  if(!canChangeset(tenant,approve))return reply(operation.read?{kind:'unavailable'}:error('permission_denied'),operation.read?200:403);
  if(!config)return reply(operation.read?{kind:'unavailable'}:error('unavailable'),503);
  const db=queryBudget(tenant.db,750);
  let identity,targets=[];
  try{
    const body=await boundedBody(request);if(!validArgs(name,body))return reply(error('validation_failed'),400);
    if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE name='_governance_changesets' AND type='table'").first())return reply({kind:'unavailable'},503);
    if(body.idempotencyKey){
      identity=await receiptIdentity({deploymentId:config.deployment,principalId:tenant.governance.actor.principalId,operation:operation.name,idempotencyKey:body.idempotencyKey},body);
      const r=await replay(db,identity);if(r)return r;
    }
    await assertGenericState(db);
    if(name==='preview')return reply(success((await preview(db,tenant,config,body)).value));
    const view=checkedReads(db),loaded=body.proposalId?await load(view,body.proposalId):null;
    if(body.proposalId){
      if(!loaded || !loaded.proposal)return identity?settle(db,identity,[],404,'unavailable'):reply({kind:'unavailable'});
      targets=JSON.parse(loaded.targets_json);
      if(name==='proposals/get'){await db.batch(readGuards(db,view.reads));return reply(success(loaded.proposal));}
      if(loaded.version!==body.expectedVersion || loaded.state!=='pending')return identity?settle(db,identity,targets,409,'proposal_changed'):reply({kind:'unavailable'});
    }
    if(name==='proposals/preview'){
      const p=await preview(db,tenant,config,loaded.proposal.input,{id:loaded.id,version:loaded.version});
      await db.batch(readGuards(db,view.reads));
      if(p.dependencies!==loaded.proposal.dependencies || !same(p.changes,loaded.proposal.changes))return reply(error('revision_changed'),409);
      return reply(success(p.value));
    }
    if(name==='proposals/reject'){
      const now=new Date().toISOString(),result=success({...loaded.proposal,state:'rejected',updatedAt:now});
      await db.batch([...readGuards(db,view.reads),db.prepare("UPDATE _governance_changesets SET state='rejected',updated_at=? WHERE id=?").bind(now,loaded.id),
        changesetReceipt(db,identity,200,targets,'SELECT ? AS result',[JSON.stringify(result)])]);
      return reply(result);
    }
    const binding=await unseal(config,body.previewToken);
    if(!object(binding) || binding.type!=='changeset-preview' || binding.principal!==tenant.governance.actor.principalId || !validInput(binding.input)
      || (approve?!same(binding.proposal,{id:loaded.id,version:loaded.version}):binding.proposal!==null))return reply(error('validation_failed'),400);
    targets=binding.input.operations.map(o=>({table:o.table,id:null}));
    if(Date.parse(binding.expiresAt)<=Date.now())return settle(db,identity,targets,409,'expired_preview');
    const operationId=crypto.randomUUID(),p=await plan(db,tenant,binding.input,approve?tenant.governance.actor:null,approve?operationId:null);
    targets=p.targets;
    if(p.dependencies!==binding.dependencies || !same(p.changes,binding.changes)
      || approve && (p.dependencies!==loaded.proposal.dependencies || !same(binding.input,loaded.proposal.input) || !same(p.changes,loaded.proposal.changes)))
      return settle(db,identity,targets,409,'revision_changed');
    for(const [key,r] of view.reads)p.view.reads.set(key,r);
    const now=new Date().toISOString();
    if(approve){
      const receipt=changesetReceipt(db,identity,200,targets,resultSQL(binding.input.operations),
        [JSON.stringify(binding.input.operations),operationId,loaded.id,loaded.version,JSON.stringify(tenant.governance.actor),now]);
      await commitChangeset(p.prepared,{after:[db.prepare("UPDATE _governance_changesets SET state='approved',updated_at=? WHERE id=?").bind(now,loaded.id),receipt]});
      return replay(db,identity);
    }
    const proposal={id:crypto.randomUUID(),version:crypto.randomUUID(),state:'pending',input:binding.input,changes:p.changes,dependencies:p.dependencies,
      proposedBy:tenant.governance.actor,claimedOrigin:body.claimedOrigin ?? null,createdAt:now,updatedAt:now};
    const result=success(proposal);
    await db.batch([...readGuards(db,p.view.reads),db.prepare('INSERT INTO _governance_changesets VALUES(?,?,?,?,?,?)')
      .bind(proposal.id,proposal.version,'pending',JSON.stringify(proposal),JSON.stringify(targets),now),
      changesetReceipt(db,identity,200,targets,'SELECT ? AS result',[JSON.stringify(result)])]);
    return reply(result);
  }catch(e){
    if(identity){const existing=await replay(db,identity);if(existing)return existing;}
    const message=String(e),conflict=/revision_conflict|life_write_conflict|integer overflow/.test(message),invalid=/validation_failed|life_invariant_|life_property_|invalid_changeset|life_outbox_event_size|changeset_capacity|life_write_budget/.test(message);
    if(identity && (conflict||invalid))return settle(db,identity,targets,conflict?409:422,conflict?'revision_changed':'validation_failed');
    if(e instanceof ScopeDenied)return reply(operation.read?{kind:'unavailable'}:error('unavailable'),operation.read?200:404);
    return reply(error(conflict?'revision_changed':invalid?'validation_failed':'unavailable'),conflict?409:invalid?422:503);
  }
}
