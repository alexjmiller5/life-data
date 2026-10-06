import {governanceFailure} from './governance-protocol.js';
import {configuration,exact,object,nonempty,validTarget,validIntent,issuePreview,planPreview,limits,unseal,seal,permits,same,conflict} from './governance-preview.js';
import {ScopeDenied,scopedTable} from './scopes.js';
import {checkedReads,readGuards,queryBudget} from './write.js';
import {commitPreparedPatch} from './patch.js';
import {ensureProposalStorage,loadProposal,storeProposal} from './governance-proposals.js';
import {receiptIdentity,readReceipt,receiptStatement} from './governance-store.js';
import {verifiedEvent,inverseEvidence} from './governance-evidence.js';
import {qident} from './validate.js';
import {assertGenericState} from './governance-isolation.js';
export const governanceReply=(result,status=200)=>Response.json(result,{status,headers:{'Cache-Control':'no-store'}});
const success=value=>({kind:'success',value});
const unavailable=()=>governanceReply({kind:'unavailable'});
const errorBody=(code,resolution='unresolved',conflicts=[])=>({kind:'error',code,resolution,conflicts});
const error=(status,code,conflicts=[])=>governanceReply(errorBody(code,'unresolved',conflicts),status);
const columns=planned=>planned?.preview.changes.map(c=>c.column) ?? [];
import {validGovernanceArgs,isHistory} from '../../core/src/governance-wire.ts';
const validArgs=(name,body)=>validGovernanceArgs(name,body,limits);
async function boundedBody(request){
  const reader=request.body?.getReader();if(!reader)throw 400;
  const parts=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limits.maxRequestBytes){await reader.cancel();throw 413;}parts.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw 400;}
}
async function replay(db,tenant,identity,approve){
  const scope=await db.prepare('SELECT tbl,row_id FROM _governance_receipts WHERE receipt_key=?').bind(identity.key).first();
  if(!scope)return null;
  if(!permits(tenant,{table:scope.tbl,rowId:scope.row_id},approve))throw new ScopeDenied();
  const receipt=await readReceipt(db,identity);
  if(!receipt)return null;
  return receipt.mismatch?error(409,'idempotency_conflict'):governanceReply(receipt.result,receipt.status);
}
async function settle(db,tenant,identity,target,status,code,cols=[],conflicts=[]){
  // Terminal rejection retains no historical IDs or field details that a
  // concurrent purge would need to chase. Preview already carries diagnostics.
  const result=errorBody(code,'not_committed',[]);
  try{await db.batch([receiptStatement(db,identity,target,cols,status,'SELECT ? AS result',[JSON.stringify(result)])]);}
  catch(e){const existing=await replay(db,tenant,identity,false);if(existing)return existing;throw e;}
  return governanceReply(result,status);
}
async function checkedToken(config,tenant,token){
  const binding=await unseal(config,token);
  if(!object(binding) || binding.type!=='preview' || binding.principal!==tenant.governance.actor.principalId || !validTarget(binding.target) || !validIntent(binding.intent))throw new ScopeDenied();
  return binding;
}
async function proposalPreview(db,tenant,config,body){
  const view=checkedReads(db),loaded=await loadProposal(view,tenant,body.proposalId);
  if(!loaded?.proposal || loaded.header.state!=='pending')return unavailable();
  const p=loaded.proposal;
  if(p.version!==body.expectedVersion){
    await db.batch(readGuards(db,view.reads));
    return governanceReply(success({target:p.target,revision:p.baseRevision,changes:[],selectedEventIds:[],conflicts:[conflict('proposal_changed')],previewToken:null,expiresAt:null}));
  }
  const planned=await issuePreview(db,tenant,config,{target:p.target,intent:p.intent},{id:p.id,version:p.version});
  if(!planned)return unavailable();
  // Stored base/patch never silently rebase. A fresh version needs review.
  if(!same(planned.preview.revision,p.baseRevision) || (!planned.preview.conflicts.length && !same(planned.preview.changes,p.changes))){
    planned.preview={...planned.preview,changes:[],conflicts:[conflict('revision_changed')],previewToken:null,expiresAt:null};
  }
  await db.batch(readGuards(db,new Map([...view.reads,...planned.view.reads])));
  return governanceReply(success(planned.preview));
}
async function mutate(db,tenant,config,operation,body){
  const approve=operation.name==='approveProposal';
  const identity=await receiptIdentity({deploymentId:config.deployment,principalId:tenant.governance.actor.principalId,operation:operation.name,idempotencyKey:body.idempotencyKey},body);
  const existing=await replay(db,tenant,identity,approve);if(existing)return existing;
  const view=checkedReads(db);
  let loaded=null,binding=null,target;
  if(operation.name!=='createProposal'){
    loaded=await loadProposal(view,tenant,body.proposalId);
    if(!loaded)return error(404,'unavailable');
    target=loaded.target;
    if(!permits(tenant,target,approve))throw new ScopeDenied();
    if(!loaded.proposal)return settle(db,tenant,identity,target,404,'unavailable');
    if(loaded.header.version!==body.expectedVersion || loaded.header.state!=='pending')return settle(db,tenant,identity,target,409,'proposal_changed');
  }
  if(body.previewToken){
    binding=await checkedToken(config,tenant,body.previewToken);
    if(target && !same(target,binding.target))return error(400,'validation_failed');
    target=binding.target;
    if(!permits(tenant,target,approve))throw new ScopeDenied();
    if((approve && !same(binding.proposal,{id:body.proposalId,version:body.expectedVersion})) || (!approve && binding.proposal!==null))return error(400,'validation_failed');
    if(Date.parse(binding.expiresAt)<=Date.now())return settle(db,tenant,identity,target,409,'expired_preview');
  }
  const operationId=crypto.randomUUID(),now=new Date().toISOString();
  let planned=null;
  if(binding){
    planned=await planPreview(db,tenant,{target,intent:binding.intent},{actor:tenant.governance.actor,operationId});
    if(!planned)return settle(db,tenant,identity,target,404,'unavailable');
    if(!same(planned.preview.revision,binding.revision))return settle(db,tenant,identity,target,409,'revision_changed');
    if(planned.preview.conflicts.length){
      const history=planned.preview.conflicts.some(c=>c.code==='history_unavailable');
      return settle(db,tenant,identity,target,422,history?'history_unavailable':'validation_failed',columns(planned),planned.preview.conflicts);
    }
    if(!same(planned.preview.changes,binding.changes) || !same(planned.preview.selectedEventIds,binding.selectedEventIds) || planned.dependenciesHash!==binding.dependencies)return settle(db,tenant,identity,target,409,'revision_changed',columns(planned));
    if(approve && (!same(loaded.proposal.baseRevision,binding.revision) || !same(loaded.proposal.changes,binding.changes) || !same(loaded.proposal.intent,binding.intent)))return settle(db,tenant,identity,target,409,'proposal_changed',columns(planned));
    for(const [key,read] of view.reads)planned.view.reads.set(key,read);
  }
  try{
    if(approve){
      const resultSql=`SELECT json_object('kind','success','value',json_object('operationId',?,'proposalId',?,'proposalVersion',?,'target',json(?),'revision',json_object('updated_at',updated_at,'hub_at',${planned.plan.stamping?'hub_at':'NULL'}),'historyEventIds',json((SELECT json_group_array(event_id) FROM (SELECT event_id FROM _governance_history WHERE operation_id=? ORDER BY seq))),'approvedBy',json(?),'committedAt',?)) AS result FROM ${qident(target.table)} WHERE id=?`;
      const result=await commitPreparedPatch(planned.plan,{after:[
        db.prepare("UPDATE _governance_proposals SET state='approved',updated_at=? WHERE id=?").bind(now,body.proposalId),
        receiptStatement(db,identity,target,columns(planned),200,resultSql,[operationId,body.proposalId,body.expectedVersion,JSON.stringify(target),operationId,JSON.stringify(tenant.governance.actor),now,target.rowId]),
      ]});
      if(result instanceof Response){
        if(result.status===503)return error(503,'unavailable');
        return settle(db,tenant,identity,target,result.status===409?409:422,result.status===409?'revision_changed':'validation_failed',columns(planned));
      }
      return replay(db,tenant,identity,true);
    }
    let proposal,statements;
    if(operation.name==='rejectProposal'){
      proposal={...loaded.proposal,state:'rejected',updatedAt:now};
      statements=[db.prepare("UPDATE _governance_proposals SET state='rejected',updated_at=? WHERE id=?").bind(now,proposal.id)];
    }else{
      proposal={id:loaded?.proposal.id ?? crypto.randomUUID(),version:crypto.randomUUID(),target,intent:binding.intent,changes:planned.preview.changes,baseRevision:planned.preview.revision,state:'pending',proposedBy:tenant.governance.actor,claimedOrigin:body.claimedOrigin ?? null,createdAt:loaded?.proposal.createdAt ?? now,updatedAt:now};
      statements=storeProposal(db,proposal,!loaded);
    }
    const result=success(proposal);
    await db.batch([...readGuards(db,planned?.view.reads ?? view.reads),...statements,receiptStatement(db,identity,target,proposal.changes.map(c=>c.column),200,'SELECT ? AS result',[JSON.stringify(result)])]);
    return governanceReply(result);
  }catch(e){
    const existing=await replay(db,tenant,identity,approve);if(existing)return existing;
    if(/life_write_conflict|integer overflow/.test(String(e)))return settle(db,tenant,identity,target,409,loaded?'proposal_changed':'revision_changed',columns(planned));
    throw e;
  }
}
async function readPage(db,tenant,config,name,body){
  const view=checkedReads(db),limit=body.limit ?? 50;
  const filter={target:body.target ?? null,state:body.state ?? null};
  let after='';
  if(body.cursor){
    const cursor=await unseal(config,body.cursor);
    if(!cursor || cursor.type!=='cursor' || cursor.operation!==name || cursor.principal!==tenant.governance.actor.principalId || !same(cursor.filter,filter) || !nonempty(cursor.after))return unavailable();
    after=cursor.after;
  }
  let rows,values;
  if(name==='historyEvents'){
    if(!permits(tenant,body.target))throw new ScopeDenied();
    await scopedTable(view,body.target.table);
    if(!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'").first())return governanceReply(success({events:[],nextCursor:null}));
    rows=(await view.prepare('SELECT * FROM history WHERE tbl=? AND row_id=? AND deleted_at IS NULL AND id>? ORDER BY id LIMIT ?').bind(body.target.table,body.target.rowId,after,limit+1).all()).results;
    values=[];
    for(const row of rows.slice(0,limit)){
      const metadata=await view.prepare('SELECT * FROM _governance_history WHERE event_id=?').bind(row.id).first();
      let event=metadata?verifiedEvent(metadata,row):null;
      if(event){
        const current=await view.prepare(`SELECT updated_at,${(await scopedTable(view,body.target.table)).some(c=>c.name==='hub_at')?'hub_at':'NULL AS hub_at'} FROM ${qident(body.target.table)} WHERE id=?`).bind(body.target.rowId).first();
        if(!current || !(await inverseEvidence(view,body.target,current,[row.id])).complete)event={...event,reversible:false,unavailableReason:'Complete history is unavailable.'};
      }
      event=event ?? {id:row.id,operationId:null,target:body.target,column:row.col,before:null,after:null,occurredAt:row.created_at,actor:null,claimedOrigin:row.origin,reversible:false,unavailableReason:'Typed history is unavailable.'};
      if(!isHistory(event))return unavailable();
      values.push(event);
    }
  }else{
    // Filter by authorized base tables before paging; inaccessible proposals
    // cannot create empty pages, cursors, placeholders or visible counts.
    const {results:catalog}=await view.prepare("SELECT id FROM catalog_tables WHERE deleted_at IS NULL AND (kind IS NULL OR kind='' OR kind='table') ORDER BY id").all();
    const allowed=[];
    for(const {id} of catalog){
      if(body.target && body.target.table!==id || !permits(tenant,{table:id,rowId:'authorization'}))continue;
      try{await scopedTable(view,id);allowed.push(id);}catch(e){if(!(e instanceof ScopeDenied))throw e;}
    }
    const where=['tbl IN (SELECT value FROM json_each(?))',"state!='purged'",'id>?'],args=[JSON.stringify(allowed),after];
    if(body.target){where.push('row_id=?');args.push(body.target.rowId);}
    if(body.state){where.push('state=?');args.push(body.state);}
    rows=(await view.prepare(`SELECT * FROM _governance_proposals WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).bind(...args,limit+1).all()).results;
    values=[];for(const row of rows.slice(0,limit)){const loaded=await loadProposal(view,tenant,row.id);if(loaded?.proposal)values.push(loaded.proposal);}
  }
  await db.batch(readGuards(db,view.reads));
  const nextCursor=rows.length>limit?await seal(config,{type:'cursor',operation:name,principal:tenant.governance.actor.principalId,filter,after:rows[limit-1].id}):null;
  return governanceReply(success({[name==='historyEvents'?'events':'proposals']:values,nextCursor}));
}
export async function handleGovernance(request,tenant,env,operation){
  const config=configuration(env);if(!config)return governanceFailure(operation,503);
  tenant={...tenant,db:queryBudget(tenant.db,750)};
  try{
    let body;try{body=await boundedBody(request);}catch(status){return governanceFailure(operation,status===413?413:400,'validation_failed');}
    if(!validArgs(operation.name,body))return governanceFailure(operation,400,'validation_failed');
    if(!await tenant.db.prepare("SELECT 1 FROM sqlite_master WHERE name='_governance_history' AND type='table'").first())return governanceFailure(operation,503);
    await assertGenericState(tenant.db);
    if(!operation.read){await ensureProposalStorage(tenant.db);return await mutate(tenant.db,tenant,config,operation,body);}
    if(operation.name==='previewChanges'){
      const planned=await issuePreview(tenant.db,tenant,config,body);
      return governanceReply(planned?success(planned.preview):{kind:'unavailable'});
    }
    if(operation.name==='previewProposal')return await proposalPreview(tenant.db,tenant,config,body);
    if(operation.name==='getProposal'){
      const view=checkedReads(tenant.db),loaded=await loadProposal(view,tenant,body.proposalId,body.version);
      if(!loaded?.proposal)return unavailable();
      await scopedTable(view,loaded.target.table);await tenant.db.batch(readGuards(tenant.db,view.reads));return governanceReply(success(loaded.proposal));
    }
    return await readPage(tenant.db,tenant,config,operation.name,body);
  }catch(e){
    if(e instanceof ScopeDenied)return governanceFailure(operation,operation.read?200:404,'unavailable');
    return governanceFailure(operation,503);
  }
}
