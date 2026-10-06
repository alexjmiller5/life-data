import type {Actor,GovernanceCapability,GovernanceLimits,Intent,Target} from './contract.generated.ts';
import {isCellValue} from './governance.ts';
import {validEditTimestamp} from './validate.ts';
export const governanceOperations={
  historyEvents:{route:'/v1/governance/history/events',read:true,required:['target'],optional:['cursor','limit']},
  previewChanges:{route:'/v1/governance/preview',read:true,preview:true,required:['target','intent'],optional:[]},
  createProposal:{route:'/v1/governance/proposals/create',required:['previewToken','idempotencyKey'],optional:['claimedOrigin']},
  listProposals:{route:'/v1/governance/proposals/list',read:true,required:[],optional:['target','state','cursor','limit']},
  getProposal:{route:'/v1/governance/proposals/get',read:true,required:['proposalId'],optional:['version']},
  editProposal:{route:'/v1/governance/proposals/edit',required:['proposalId','expectedVersion','previewToken','idempotencyKey'],optional:['claimedOrigin']},
  previewProposal:{route:'/v1/governance/proposals/preview',read:true,preview:true,required:['proposalId','expectedVersion'],optional:[]},
  approveProposal:{route:'/v1/governance/proposals/approve',required:['proposalId','expectedVersion','previewToken','idempotencyKey'],optional:[]},
  rejectProposal:{route:'/v1/governance/proposals/reject',required:['proposalId','expectedVersion','idempotencyKey'],optional:[]},
} as const;
export type GovernanceOperation=keyof typeof governanceOperations;
export type GovernanceRoute=typeof governanceOperations[GovernanceOperation]['route'];
export const object=(x:unknown):x is Record<string,unknown>=>x!==null && typeof x==='object' && [Object.prototype,null].includes(Object.getPrototypeOf(x));
export const nonempty=(x:unknown):x is string=>typeof x==='string' && x.trim().length>0;
export const exact=(x:unknown,required:readonly string[],optional:readonly string[]=[]):x is Record<string,unknown>=>object(x) && required.every(k=>Object.hasOwn(x,k)) && Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
export const isTarget=(x:unknown):x is Target=>exact(x,['table','rowId']) && typeof x.table==='string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(x.table) && nonempty(x.rowId);
export const isActor=(x:unknown):x is Actor=>exact(x,['principalId','kind']) && nonempty(x.principalId) && typeof x.kind==='string' && ['user','agent','service'].includes(x.kind);
export const texts=(x:unknown):x is string[]=>Array.isArray(x) && x.every(nonempty) && new Set(x).size===x.length;
const positive=(x:unknown)=>typeof x==='number' && Number.isSafeInteger(x) && x>0;
export function isGovernanceCapability(x:unknown):x is GovernanceCapability {
  return exact(x,['protocol','principal','authority','limits','deploymentId','sessionId']) && x.protocol==='selected-inverse-proposals-v1' && isActor(x.principal) && nonempty(x.deploymentId) && nonempty(x.sessionId)
    && exact(x.authority,['propose','approve']) && typeof x.authority.propose==='boolean' && typeof x.authority.approve==='boolean'
    && (!x.authority.approve || x.principal.kind==='user')
    && exact(x.limits,['maxSelectedEvents','maxChangedColumns','maxRequestBytes','maxPageSize','previewTtlSeconds']) && Object.values(x.limits).every(positive);
}
export function isIntent(x:unknown,limits?:GovernanceLimits):x is Intent {
  if(exact(x,['kind','eventIds']) && x.kind==='selected_inverse')return texts(x.eventIds) && x.eventIds.length>0 && (!limits || x.eventIds.length<=limits.maxSelectedEvents);
  if(!exact(x,['kind','changes']) || x.kind!=='patch' || !Array.isArray(x.changes) || !x.changes.length || (limits && x.changes.length>limits.maxChangedColumns))return false;
  return x.changes.every(c=>exact(c,['column','after']) && nonempty(c.column) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.column) && isCellValue(c.after)) && new Set(x.changes.map(c=>c.column)).size===x.changes.length;
}
export function validGovernanceArgs(name:GovernanceOperation,x:unknown,limits:GovernanceLimits):boolean {
  const op=governanceOperations[name];if(!exact(x,op.required,op.optional))return false;
  for(const k of ['proposalId','expectedVersion','previewToken','idempotencyKey','cursor','version'])if(Object.hasOwn(x,k) && !nonempty(x[k]))return false;
  return (!Object.hasOwn(x,'target')||isTarget(x.target)) && (!Object.hasOwn(x,'intent')||isIntent(x.intent,limits))
    && (!Object.hasOwn(x,'claimedOrigin')||typeof x.claimedOrigin==='string')
    && (!Object.hasOwn(x,'state')||typeof x.state==='string' && ['pending','approved','rejected'].includes(x.state))
    && (!Object.hasOwn(x,'limit')||(positive(x.limit) && Number(x.limit)<=limits.maxPageSize));
}
export const isRead=(name:GovernanceOperation)=>'read' in governanceOperations[name];
export const sameTarget=(a:Target,b:Target)=>a.table===b.table && a.rowId===b.rowId;
export const sameActor=(a:Actor,b:Actor)=>a.principalId===b.principalId && a.kind===b.kind;
const nullableText=(x:unknown)=>x===null || typeof x==='string';
const revision=(x:unknown)=>exact(x,['updated_at','hub_at']) && validEditTimestamp(x.updated_at) && (x.hub_at===null||validEditTimestamp(x.hub_at));
export const conflicts=(x:unknown):boolean=>Array.isArray(x) && x.every(c=>exact(c,['code','column','eventIds','message'])
  && typeof c.code==='string' && ['later_column_change','history_unavailable','revision_changed','validation_failed','proposal_changed','unavailable'].includes(c.code)
  && (c.column===null || nonempty(c.column)) && texts(c.eventIds) && typeof c.message==='string');
const changes=(x:unknown):boolean=>Array.isArray(x) && x.every(c=>exact(c,['column','before','after']) && nonempty(c.column) && isCellValue(c.before) && isCellValue(c.after)) && new Set(x.map(c=>c.column)).size===x.length;
export function isPreview(x:unknown):boolean {
  return exact(x,['target','revision','changes','selectedEventIds','conflicts','previewToken','expiresAt']) && isTarget(x.target) && revision(x.revision) && changes(x.changes) && texts(x.selectedEventIds) && conflicts(x.conflicts)
    && (x.previewToken===null?x.expiresAt===null:nonempty(x.previewToken) && validEditTimestamp(x.expiresAt) && (x.conflicts as unknown[]).length===0 && (x.changes as unknown[]).length>0);
}
export function isProposal(x:unknown):boolean {
  return exact(x,['id','version','target','intent','changes','baseRevision','state','proposedBy','claimedOrigin','createdAt','updatedAt'])
    && nonempty(x.id) && nonempty(x.version) && isTarget(x.target) && isIntent(x.intent) && changes(x.changes) && revision(x.baseRevision)
    && typeof x.state==='string' && ['pending','approved','rejected'].includes(x.state) && isActor(x.proposedBy) && nullableText(x.claimedOrigin) && validEditTimestamp(x.createdAt) && validEditTimestamp(x.updatedAt);
}
export function isApproval(x:unknown):boolean {
  return exact(x,['operationId','proposalId','proposalVersion','target','revision','historyEventIds','approvedBy','committedAt'])
    && nonempty(x.operationId) && nonempty(x.proposalId) && nonempty(x.proposalVersion) && isTarget(x.target) && revision(x.revision)
    && texts(x.historyEventIds) && isActor(x.approvedBy) && x.approvedBy.kind==='user' && validEditTimestamp(x.committedAt);
}
export function isHistory(x:unknown):boolean {
  return exact(x,['id','operationId','target','column','before','after','occurredAt','actor','claimedOrigin','reversible','unavailableReason'])
    && nonempty(x.id) && (x.operationId===null||nonempty(x.operationId)) && isTarget(x.target) && nonempty(x.column)
    && (x.before===null||isCellValue(x.before)) && (x.after===null||isCellValue(x.after)) && nonempty(x.occurredAt)
    && (x.actor===null||isActor(x.actor)) && nullableText(x.claimedOrigin) && typeof x.reversible==='boolean' && nullableText(x.unavailableReason)
    && (!x.reversible || (x.before!==null && x.after!==null));
}
export const utf8Length=(text:string)=>{let length=0;for(const ch of text){const cp=ch.codePointAt(0)!;length+=cp<128?1:cp<2048?2:cp<65536?3:4;}return length;};
