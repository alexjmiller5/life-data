/** Pure boundary checks. Hosts own transport, secure credentials and retries.
 * A null result is indeterminate/non-success; it never means an earlier attempt
 * did not commit. Existing confirms presence only, not creation attribution. */
import {validEditTimestamp} from './validate.ts';
import type {CreationPolicyRef,RowCreationReceipt,RowCreationRequest,SessionReply} from './contract.generated.ts';
export type {CreationPolicyRef,RowCreationCapability,RowCreationRequest,RowCreationReceipt} from './contract.generated.ts';
const object=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v);
const keys=(v:unknown,names:string[]):v is Record<string,unknown>=>object(v) && Object.keys(v).sort().join(',')===[...names].sort().join(',');
const ref=(v:unknown):v is CreationPolicyRef=>keys(v,['id','revision']) && typeof v.id==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v.id) && typeof v.revision==='string' && /^[0-9a-f]{64}$/.test(v.revision);
const same=(a:unknown,b:CreationPolicyRef)=>ref(a) && ref(b) && a.id===b.id && a.revision===b.revision;
export function validateCreationReceipt(request:RowCreationRequest,reply:SessionReply):RowCreationReceipt|null {
  const r=reply.data;
  if(reply.status!==200 || !object(r) || !same(r.policy,request.policy) || r.id!==request.target.id)return null;
  if(r.kind==='existing' && keys(r,['kind','policy','id']))return r as unknown as RowCreationReceipt;
  if(r.kind!=='created' || request.target.kind!=='generated' || !keys(r,['kind','policy','id','revision','originId'])
    || !keys(r.revision,['updated_at','hub_at']) || r.revision.updated_at!==request.updatedAt
    || !validEditTimestamp(r.revision.updated_at) || !validEditTimestamp(r.revision.hub_at)
    || typeof r.originId!=='string' || !r.originId.endsWith(':'+request.sourceId+':'+request.target.id)
    || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(r.originId.slice(0,-(request.sourceId.length+request.target.id.length+2))))return null;
  return r as unknown as RowCreationReceipt;
}
export function validateCreationSession(reply:SessionReply,expected:CreationPolicyRef,expectedScopes:readonly string[]):boolean {
  const s=reply.data;
  if(reply.status!==200 || !ref(expected) || !object(s) || !Array.isArray(s.scopes) || s.scopes.some(v=>typeof v!=='string')
    || s.scopes.length!==new Set(s.scopes).size || expectedScopes.length!==new Set(expectedScopes).size
    || s.scopes.length!==expectedScopes.length || expectedScopes.some(v=>!(s.scopes as unknown[]).includes(v))
    || !expectedScopes.includes(`rows:create:${expected.id}:${expected.revision}`)
    || expectedScopes.some(v=>v!==`rows:create:${expected.id}:${expected.revision}` && !/^tables:read:[A-Za-z][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$/.test(v))
    || !object(s.capabilities) || Object.hasOwn(s.capabilities,'governance'))return false;
  const c=s.capabilities.rowCreation;
  return keys(c,['protocol','policies']) && c.protocol==='atomic-origin-v1' && Array.isArray(c.policies)
    && c.policies.length===1 && c.policies.every(ref) && c.policies.some(p=>same(p,expected))
    && new Set(c.policies.map(p=>p.id)).size===c.policies.length;
}
