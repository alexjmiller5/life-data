import type {CoreArgs,CoreResult,GovernanceCapability,SessionReply,Actor,Target,MutationError,MutationErrorCode,UnavailableResult} from './contract.generated.ts';
import {governanceOperations,isRead,isGovernanceCapability,validGovernanceArgs,exact,object,nonempty,conflicts,isPreview,isProposal,isApproval,isHistory,sameTarget,sameActor,utf8Length} from './governance-wire.ts';
import type {GovernanceOperation,GovernanceRoute} from './governance-wire.ts';
export type {GovernanceOperation,GovernanceRoute} from './governance-wire.ts';
export type GovernanceAPI={ [M in GovernanceOperation]:(args:CoreArgs<M>)=>Promise<CoreResult<M>> };
/** The host may report notDispatched only before HTTP starts. Exceptions after
 * dispatch, including a timeout or dropped response, remain indeterminate. */
export type GovernanceTransport=(route:GovernanceRoute,body:unknown)=>Promise<SessionReply|{notDispatched:true}>;
const indeterminate=()=>({kind:'transport_error',code:'indeterminate'} as const);
const denied=(name:GovernanceOperation,code:MutationErrorCode='unavailable'):MutationError|UnavailableResult=>isRead(name)?{kind:'unavailable'}:{kind:'error',code,resolution:'unresolved',conflicts:[]};
const nullableCursor=(x:unknown)=>x===null || nonempty(x);
function valueMatches(name:GovernanceOperation,args:Record<string,unknown>,value:unknown,cap:GovernanceCapability):boolean {
  if(name==='approveProposal')return isApproval(value) && object(value) && value.proposalId===args.proposalId && value.proposalVersion===args.expectedVersion && sameActor(value.approvedBy as Actor,cap.principal);
  if(name==='previewChanges'||name==='previewProposal')return isPreview(value) && object(value) && (!args.target || sameTarget(value.target as Target,args.target as Target));
  if(name==='historyEvents')return exact(value,['events','nextCursor']) && Array.isArray(value.events) && value.events.length<=(args.limit as number ?? cap.limits.maxPageSize) && value.events.every(e=>isHistory(e) && sameTarget(e.target,args.target as Target)) && new Set(value.events.map(e=>e.id)).size===value.events.length && nullableCursor(value.nextCursor);
  if(name==='listProposals')return exact(value,['proposals','nextCursor']) && Array.isArray(value.proposals) && value.proposals.length<=(args.limit as number ?? cap.limits.maxPageSize) && value.proposals.every(p=>isProposal(p) && (!args.target || sameTarget(p.target,args.target as Target)) && (!args.state || p.state===args.state)) && new Set(value.proposals.map(p=>p.id)).size===value.proposals.length && nullableCursor(value.nextCursor);
  if(!isProposal(value) || !object(value))return false;
  if(args.proposalId && value.id!==args.proposalId || args.version && value.version!==args.version)return false;
  if(name==='rejectProposal')return value.state==='rejected' && value.version===args.expectedVersion;
  if(name==='createProposal'||name==='editProposal')return value.state==='pending' && sameActor(value.proposedBy as Actor,cap.principal) && (name!=='editProposal'||value.version!==args.expectedVersion);
  return true;
}
/** Only this exhaustive status/body pairing may settle a dispatched mutation. */
export function parseGovernanceReply<M extends GovernanceOperation>(name:M,args:CoreArgs<M>,reply:unknown,capability:GovernanceCapability):CoreResult<M> {
  const fail=()=>indeterminate() as CoreResult<M>;
  try{
    if(!isGovernanceCapability(capability) || !validGovernanceArgs(name,args,capability.limits))return fail();
    if(!exact(reply,['status','data'],['retryAfterSeconds']) || !Number.isInteger(reply.status) || !object(reply.data))return fail();
    const status=reply.status as number,data=reply.data;
    if(status===429 && (typeof reply.retryAfterSeconds!=='number'||!Number.isSafeInteger(reply.retryAfterSeconds)||reply.retryAfterSeconds<=0))return fail();
    if(status===200 && exact(data,['kind','value']) && data.kind==='success')return valueMatches(name,args as Record<string,unknown>,data.value,capability)?data as CoreResult<M>:fail();
    if(isRead(name))return [200,400,401,413,429,503].includes(status) && exact(data,['kind']) && data.kind==='unavailable'?data as CoreResult<M>:fail();
    if(status===200 && exact(data,['kind']) && data.kind==='purged')return data as CoreResult<M>;
    if(!exact(data,['kind','code','resolution','conflicts']) || data.kind!=='error' || typeof data.code!=='string' || typeof data.resolution!=='string' || !['unresolved','not_committed'].includes(data.resolution) || !conflicts(data.conflicts))return fail();
    const matrix:Record<number,readonly string[]>={400:['validation_failed'],401:['permission_denied'],403:['permission_denied'],404:['unavailable'],409:['proposal_changed','revision_changed','expired_preview','idempotency_conflict'],413:['validation_failed'],422:['validation_failed','history_unavailable'],429:['unavailable'],503:['unavailable']};
    if(!matrix[status]?.includes(data.code))return fail();
    if(data.resolution==='not_committed' && (![404,409,422].includes(status)||data.code==='idempotency_conflict'))return fail();
    const mayDisclose=status===422 || status===409 && data.code!=='idempotency_conflict';
    if(!mayDisclose && (data.conflicts as unknown[]).length)return fail();
    return data as CoreResult<M>;
  }catch{return fail();}
}
export function unavailableGovernance():GovernanceAPI {
  return Object.fromEntries((Object.keys(governanceOperations) as GovernanceOperation[]).map(name=>[name,async()=>denied(name)])) as unknown as GovernanceAPI;
}
/** Capability and raw transport must both be supplied for this credential.
 * Hosts replace this instance on deployment/session/workspace change. */
export function createGovernanceAPI(capability:unknown,transport:GovernanceTransport|undefined):GovernanceAPI|null {
  if(!isGovernanceCapability(capability)||typeof transport!=='function'||!capability.authority.propose&&!capability.authority.approve)return null;
  const cap=JSON.parse(JSON.stringify(capability)) as GovernanceCapability;
  return Object.fromEntries((Object.keys(governanceOperations) as GovernanceOperation[]).map(name=>[name,async(input:unknown)=>{
    const authorized=name==='approveProposal'?cap.authority.approve:isRead(name)?cap.authority.propose||cap.authority.approve:cap.authority.propose;
    if(!authorized)return denied(name,'permission_denied');
    let args:CoreArgs<typeof name>;
    try{
      const serialized=JSON.stringify(input);args=JSON.parse(serialized);
      if(utf8Length(serialized)>cap.limits.maxRequestBytes || !validGovernanceArgs(name,args,cap.limits))return denied(name,'validation_failed');
    }catch{return denied(name,'validation_failed');}
    try{
      const reply=await transport(governanceOperations[name].route,args);
      if(exact(reply,['notDispatched'])&&'notDispatched' in reply&&reply.notDispatched===true)return {kind:'transport_error',code:'offline'};
      return parseGovernanceReply(name,args,reply,cap);
    }catch{return indeterminate();}
  }])) as unknown as GovernanceAPI;
}
