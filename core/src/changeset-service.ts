import type {ChangesetApprovalResult,ChangesetChange,ChangesetRowReceipt} from './contract.generated.ts';
import {exact,object,nonempty,isActor,texts,conflicts} from './governance-wire.ts';
import {validEditTimestamp} from './validate.ts';

/** The host captures this scope with its durable original-request journal before
 * dispatch. A reply for a different proposal, actor, member or lifecycle action
 * cannot acknowledge the pending set. No partial receipt is accepted. */
export type ChangesetApprovalScope={
  proposalId:string;
  proposalVersion:string;
  principalId:string;
  changes:Pick<ChangesetChange,'table'|'id'|'kind'>[];
};
const unknown=():ChangesetApprovalResult=>({kind:'transport_error',code:'indeterminate'});
const key=(r:Pick<ChangesetRowReceipt,'table'|'id'|'kind'>)=>JSON.stringify([r.table,r.id,r.kind]);
const member=(r:unknown):r is Pick<ChangesetRowReceipt,'table'|'id'|'kind'>=>object(r)
  && nonempty(r.table) && nonempty(r.id) && ['create','patch','soft_delete'].includes(String(r.kind));
const revision=(r:unknown)=>exact(r,['updated_at','hub_at']) && validEditTimestamp(r.updated_at) && validEditTimestamp(r.hub_at);

export function parseChangesetApproval(scope:ChangesetApprovalScope,reply:unknown):ChangesetApprovalResult{
  try{
    if(!exact(scope,['proposalId','proposalVersion','principalId','changes']) || !nonempty(scope.proposalId) || !nonempty(scope.proposalVersion)
      || !nonempty(scope.principalId) || !Array.isArray(scope.changes) || !scope.changes.length || scope.changes.length>64 || !scope.changes.every(member)
      || new Set(scope.changes.map(r=>JSON.stringify([r.table,r.id]))).size!==scope.changes.length)return unknown();
    if(!exact(reply,['status','data'],['retryAfterSeconds']) || !Number.isInteger(reply.status) || !object(reply.data))return unknown();
    const status=Number(reply.status),data=reply.data;
    if(status===200 && exact(data,['kind']) && data.kind==='purged')return {kind:'purged'};
    if(status===200 && exact(data,['kind','value']) && data.kind==='success'){
      const v=data.value;
      if(!exact(v,['operationId','proposalId','proposalVersion','rows','historyEventIds','approvedBy','committedAt']) || !nonempty(v.operationId)
        || v.proposalId!==scope.proposalId || v.proposalVersion!==scope.proposalVersion || !validEditTimestamp(v.committedAt)
        || !isActor(v.approvedBy) || v.approvedBy.kind!=='user' || v.approvedBy.principalId!==scope.principalId || !texts(v.historyEventIds)
        || !Array.isArray(v.rows) || v.rows.length!==scope.changes.length
        || !v.rows.every(r=>exact(r,['table','id','kind','revision']) && revision(r.revision) && member(r)))return unknown();
      const actual=v.rows as ChangesetRowReceipt[],expected=new Set(scope.changes.map(key));
      if(new Set(actual.map(key)).size!==actual.length || actual.some(r=>!expected.has(key(r))))return unknown();
      return data as ChangesetApprovalResult;
    }
    return parseChangesetFailure(reply);
  }catch{return unknown();}
}

/** Only authenticated, durable negative outcomes may settle an original request. */
export function parseChangesetFailure(reply:unknown):ChangesetApprovalResult{
  try{
    if(!exact(reply,['status','data'],['retryAfterSeconds']) || !Number.isInteger(reply.status) || !object(reply.data))return unknown();
    const status=Number(reply.status),data=reply.data;
    if(!exact(data,['kind','code','resolution','conflicts']) || data.kind!=='error' || typeof data.code!=='string'
      || !['unresolved','not_committed'].includes(String(data.resolution)) || !conflicts(data.conflicts))return unknown();
    const matrix:Record<number,readonly string[]>={400:['validation_failed'],401:['permission_denied'],403:['permission_denied'],404:['unavailable'],
      409:['proposal_changed','revision_changed','expired_preview','idempotency_conflict'],413:['validation_failed'],422:['validation_failed'],429:['unavailable'],503:['unavailable']};
    if(!matrix[status]?.includes(data.code) || (data.conflicts as unknown[]).length)return unknown();
    if(status===429 && (!Number.isSafeInteger(reply.retryAfterSeconds) || Number(reply.retryAfterSeconds)<=0))return unknown();
    if(data.resolution==='not_committed' && (![404,409,422].includes(status) || data.code==='idempotency_conflict'))return unknown();
    return data as ChangesetApprovalResult;
  }catch{return unknown();}
}
