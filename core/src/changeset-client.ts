import type {ChangesetCapability,ChangesetInput,ChangesetChange,ChangesetProposal,ChangesetPreviewResult,ChangesetProposalResult,ChangesetApprovalResult,CreateProposalArgs,GetProposalArgs,PreviewProposalArgs,ApproveProposalArgs,RejectProposalArgs,SessionReply,MutationError} from './contract.generated.ts';
import {exact,object,nonempty,isActor,utf8Length} from './governance-wire.ts';
import {validEditTimestamp} from './validate.ts';
import {parseChangesetApproval,parseChangesetFailure} from './changeset-service.ts';
export const changesetRoutes={preview:'/v1/governance/changesets/preview',createProposal:'/v1/governance/changesets/proposals/create',getProposal:'/v1/governance/changesets/proposals/get',previewProposal:'/v1/governance/changesets/proposals/preview',approveProposal:'/v1/governance/changesets/proposals/approve',rejectProposal:'/v1/governance/changesets/proposals/reject'} as const;
export type ChangesetRoute=typeof changesetRoutes[keyof typeof changesetRoutes];
export type ChangesetTransport=(route:ChangesetRoute,body:unknown)=>Promise<SessionReply|{notDispatched:true}>;
export interface ChangesetAPI {
  preview(input:unknown):Promise<ChangesetPreviewResult>;
  createProposal(args:CreateProposalArgs):Promise<ChangesetProposalResult>;
  getProposal(args:GetProposalArgs):Promise<ChangesetProposalResult>;
  previewProposal(args:PreviewProposalArgs,proposal:unknown):Promise<ChangesetPreviewResult>;
  approveProposal(args:ApproveProposalArgs,proposal:unknown):Promise<ChangesetApprovalResult>;
  rejectProposal(args:RejectProposalArgs):Promise<ChangesetProposalResult>;
}
const positive=(v:unknown)=>Number.isSafeInteger(v) && Number(v)>0;
export function isChangesetCapability(v:unknown):v is ChangesetCapability {
  return exact(v,['protocol','principal','authority','limits','deploymentId','sessionId']) && v.protocol==='bounded-changeset-proposals-v1'
    && isActor(v.principal) && nonempty(v.deploymentId) && nonempty(v.sessionId)
    && exact(v.authority,['propose','approve']) && typeof v.authority.propose==='boolean' && typeof v.authority.approve==='boolean'
    && (!v.authority.approve || v.principal.kind==='user')
    && exact(v.limits,['maxOperations','maxTables','maxBytes','maxReadSets','maxMembershipRows','maxReadRows','previewTtlSeconds']) && Object.values(v.limits).every(positive);
}
const ident=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
const revision=(v:unknown)=>exact(v,['updated_at','hub_at']) && validEditTimestamp(v.updated_at) && (v.hub_at===null || validEditTimestamp(v.hub_at));
const json=(v:unknown):boolean=>v===null || typeof v==='string' || typeof v==='boolean' || typeof v==='number' && Number.isFinite(v)
  || Array.isArray(v) && v.every(json) || object(v) && Object.values(v).every(json);
const row=(v:unknown)=>object(v) && Object.entries(v).every(([k,v])=>ident(k) && json(v));
const key=(r:{table:string,id:string,kind:string})=>JSON.stringify([r.table,r.id,r.kind]);
export function isChangesetInput(v:unknown):v is ChangesetInput {
  if(!exact(v,['operations','reads']) || !Array.isArray(v.operations) || !v.operations.length || v.operations.length>64
    || !Array.isArray(v.reads) || v.reads.length>64)return false;
  const targets=new Set<string>(),tables=new Set<string>();let count=0;
  for(const op of v.operations){
    if(!object(op) || !['create','patch','soft_delete'].includes(String(op.kind)) || !exact(op,['kind','table','id','expected_revision'],op.kind==='soft_delete'?[]:['values'])
      || !ident(op.table) || !nonempty(op.id) || (op.kind==='create'?op.expected_revision!==null:!revision(op.expected_revision))
      || (op.kind!=='soft_delete' && (!row(op.values) || !Object.keys(op.values as object).length)))return false;
    if(op.kind!=='soft_delete' && Object.keys(op.values as object).some(k=>['id','created_at','updated_at','hub_at','deleted_at'].includes(k.toLowerCase())))return false;
    const k=JSON.stringify([op.table.toLowerCase(),op.id]);if(targets.has(k))return false;targets.add(k);tables.add(op.table.toLowerCase());
  }
  if(tables.size>8)return false;
  for(const r of v.reads){
    if(!exact(r,['table','where','expected']) || !ident(r.table) || !object(r.where) || !Object.keys(r.where).length || Object.keys(r.where).length>16
      || !Object.entries(r.where).every(([k,v])=>ident(k) && (v===null || typeof v==='string' || typeof v==='boolean' || typeof v==='number' && Number.isFinite(v)))
      || !Array.isArray(r.expected) || !r.expected.every(e=>exact(e,['id','revision']) && nonempty(e.id) && revision(e.revision))
      || new Set(r.expected.map(e=>e.id)).size!==r.expected.length)return false;
    count+=r.expected.length;
  }
  return count<=2000;
}
function isChanges(v:unknown):v is ChangesetChange[]{
  return Array.isArray(v) && v.length>0 && v.length<=64 && v.every(c=>exact(c,['table','id','kind','before','after']) && ident(c.table) && nonempty(c.id)
    && (c.kind==='create'?c.before===null && row(c.after):c.kind==='patch'?row(c.before) && row(c.after):c.kind==='soft_delete' && row(c.before) && c.after===null))
    && new Set(v.map(c=>JSON.stringify([c.table,c.id]))).size===v.length;
}
const members=(changes:ChangesetChange[],input:ChangesetInput)=>changes.length===input.operations.length
  && changes.every((c,i)=>key(c)===key(input.operations[i]));
export function isChangesetProposal(v:unknown):v is ChangesetProposal {
  return exact(v,['id','version','state','input','changes','dependencies','proposedBy','claimedOrigin','createdAt','updatedAt']) && nonempty(v.id) && nonempty(v.version)
    && ['pending','approved','rejected'].includes(String(v.state)) && isChangesetInput(v.input) && isChanges(v.changes) && members(v.changes,v.input)
    && nonempty(v.dependencies) && isActor(v.proposedBy) && (v.claimedOrigin===null || typeof v.claimedOrigin==='string') && validEditTimestamp(v.createdAt) && validEditTimestamp(v.updatedAt);
}
const unknown=()=>({kind:'transport_error',code:'indeterminate'} as const);
const error=(code:'permission_denied'|'validation_failed'):MutationError=>({kind:'error',code,resolution:'unresolved',conflicts:[]});
const fields={createProposal:['previewToken','idempotencyKey'],getProposal:['proposalId'],previewProposal:['proposalId','expectedVersion'],approveProposal:['proposalId','expectedVersion','previewToken','idempotencyKey'],rejectProposal:['proposalId','expectedVersion','idempotencyKey']} as const;
export function createChangesetAPI(capability:unknown,transport:ChangesetTransport|undefined):ChangesetAPI|null {
  if(!isChangesetCapability(capability) || !transport || (!capability.authority.propose && !capability.authority.approve))return null;
  const cap=JSON.parse(JSON.stringify(capability)) as ChangesetCapability,send=transport;
  async function call(name:keyof typeof changesetRoutes,input:unknown,captured?:unknown):Promise<ChangesetPreviewResult|ChangesetProposalResult|ChangesetApprovalResult>{
    if(name==='approveProposal'?!cap.authority.approve:(name==='createProposal'||name==='rejectProposal') && !cap.authority.propose)return error('permission_denied');
    let args:Record<string,unknown>,proposal:ChangesetProposal|undefined;
    try{
      const encoded=JSON.stringify(input);if(utf8Length(encoded)>cap.limits.maxBytes)return error('validation_failed');args=JSON.parse(encoded);
      if(name==='preview'){
        if(!isChangesetInput(args) || args.operations.length>cap.limits.maxOperations || new Set(args.operations.map(o=>o.table)).size>cap.limits.maxTables || args.reads.length>cap.limits.maxReadSets
          || args.reads.reduce((n,r)=>n+r.expected.length,0)>cap.limits.maxReadRows)return error('validation_failed');
      }else if(!exact(args,fields[name],name==='createProposal'?['claimedOrigin']:[]) || !fields[name].every(f=>nonempty(args[f]))
        || (Object.hasOwn(args,'claimedOrigin') && typeof args.claimedOrigin!=='string'))return error('validation_failed');
      if(name==='previewProposal'||name==='approveProposal'){
        proposal=JSON.parse(JSON.stringify(captured));
        if(!isChangesetProposal(proposal) || proposal.state!=='pending' || proposal.id!==(args as Record<string,unknown>).proposalId || proposal.version!==(args as Record<string,unknown>).expectedVersion)return error('validation_failed');
      }
    }catch{return error('validation_failed');}
    try{
      const reply:unknown=await send(changesetRoutes[name],args);
      if(exact(reply,['notDispatched']) && reply.notDispatched===true)return {kind:'transport_error',code:'offline'};
      if(name==='approveProposal')return parseChangesetApproval({proposalId:proposal!.id,proposalVersion:proposal!.version,principalId:cap.principal.principalId,changes:proposal!.changes},reply);
      if(!exact(reply,['status','data'],['retryAfterSeconds']) || !object(reply.data))return unknown();
      const data=reply.data;
      if(reply.status===200 && exact(data,['kind']) && (data.kind==='purged'||data.kind==='unavailable'))return data as {kind:'purged'|'unavailable'};
      if(reply.status===200 && exact(data,['kind','value']) && data.kind==='success'){
        const value=data.value;
        if(name==='preview'||name==='previewProposal'){
          if(!exact(value,['changes','previewToken','expiresAt']) || !isChanges(value.changes) || !nonempty(value.previewToken) || !validEditTimestamp(value.expiresAt)
            || !members(value.changes,name==='preview'?args as unknown as ChangesetInput:proposal!.input)
            || (proposal && JSON.stringify(value.changes)!==JSON.stringify(proposal.changes)))return unknown();
          return data as ChangesetPreviewResult;
        }
        if(!isChangesetProposal(value) || ((args as Record<string,unknown>).proposalId && (args as Record<string,unknown>).proposalId!==value.id)
          || name==='createProposal' && (value.state!=='pending' || value.proposedBy.kind!==cap.principal.kind || value.proposedBy.principalId!==cap.principal.principalId)
          || name==='rejectProposal' && (value.state!=='rejected' || value.version!==(args as Record<string,unknown>).expectedVersion))return unknown();
        return data as ChangesetProposalResult;
      }
      // Reuse the canonical status/resolution checks; success is parsed above.
      return parseChangesetFailure(reply);
    }catch{return unknown();}
  }
  return {preview:input=>call('preview',input) as Promise<ChangesetPreviewResult>,createProposal:args=>call('createProposal',args) as Promise<ChangesetProposalResult>,getProposal:args=>call('getProposal',args) as Promise<ChangesetProposalResult>,previewProposal:(args,p)=>call('previewProposal',args,p) as Promise<ChangesetPreviewResult>,approveProposal:(args,p)=>call('approveProposal',args,p) as Promise<ChangesetApprovalResult>,rejectProposal:args=>call('rejectProposal',args) as Promise<ChangesetProposalResult>};
}
