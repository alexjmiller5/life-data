import {expect,test} from 'bun:test';
import {createGovernanceAPI,parseGovernanceReply} from '../src/governance-service.ts';
import {createCoreHandlers} from '../src/operations.ts';
import {createHttpHub} from '../src/http.ts';
import type {GovernanceCapability} from '../src/contract.generated.ts';
const actor={principalId:'principal',kind:'user' as const};
const capability:GovernanceCapability={protocol:'selected-inverse-proposals-v1',principal:actor,authority:{propose:true,approve:true},limits:{maxSelectedEvents:100,maxChangedColumns:64,maxRequestBytes:65536,maxPageSize:100,previewTtlSeconds:300}};
const target={table:'items',rowId:'r'},revision={updated_at:'2026-01-01T00:00:00.000Z',hub_at:null};
const args={proposalId:'p',expectedVersion:'v',previewToken:'opaque',idempotencyKey:'exact-original'};
const receipt={operationId:'op',proposalId:'p',proposalVersion:'v',target,revision,historyEventIds:[],approvedBy:actor,committedAt:'2026-01-01T00:00:00.001Z'};
const indeterminate={kind:'transport_error',code:'indeterminate'} as const;
test('missing, malformed or unsupported capabilities and adapters leave governance unavailable',()=>{
  for(const cap of [null,{}, {...capability,protocol:'unknown'}, {...capability,limits:{...capability.limits,maxPageSize:0}}, {...capability,principal:{...actor,kind:'agent'}}])expect(createGovernanceAPI(cap,async()=>({status:200,data:{kind:'purged'}}))).toBeNull();
  expect(createGovernanceAPI(capability,undefined)).toBeNull();
});
test('unconfigured core handlers expose no fallback local writer or ambient hub call',async()=>{
  const handlers=createCoreHandlers({} as never,()=>{throw Error('ambient hub');});
  expect(await handlers.approveProposal(args)).toEqual({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]});
  expect(await handlers.historyEvents({target})).toEqual({kind:'unavailable'});
});
test('transport keeps exact args/key and validates committed receipt with empty history and older revision',async()=>{
  const sent:unknown[]=[];
  const api=createGovernanceAPI(capability,async(route,body)=>{sent.push({route,body});return {status:200,data:{kind:'success',value:receipt}};})!;
  expect(await api.approveProposal(args)).toEqual({kind:'success',value:receipt});
  expect(sent).toEqual([{route:'/v1/governance/proposals/approve',body:args}]);
});
for(const [status,code,resolution] of [
 [400,'validation_failed','unresolved'],[401,'permission_denied','unresolved'],[403,'permission_denied','unresolved'],
 [404,'unavailable','unresolved'],[404,'unavailable','not_committed'],
 [409,'proposal_changed','unresolved'],[409,'revision_changed','not_committed'],[409,'expired_preview','not_committed'],[409,'idempotency_conflict','unresolved'],
 [413,'validation_failed','unresolved'],[422,'history_unavailable','not_committed'],[422,'validation_failed','unresolved'],[429,'unavailable','unresolved'],[503,'unavailable','unresolved'],
] as const)test(`strict mutation HTTP matrix ${status}/${code}/${resolution}`,()=>{
  const data={kind:'error' as const,code,resolution,conflicts:[]};
  expect(parseGovernanceReply('approveProposal',args,{status,data,...(status===429?{retryAfterSeconds:2}:{})},capability)).toEqual(data);
});
for(const reply of [
 {status:200,data:{kind:'success',value:{...receipt,requestId:'invented'}}},
 {status:200,data:{kind:'success',value:{...receipt,proposalVersion:'wrong'}}},
 {status:200,data:{kind:'success',value:{...receipt,approvedBy:{...actor,principalId:'other'}}}},
 {status:200,data:{kind:'purged',value:receipt}},
 {status:409,data:{kind:'error',code:'revision_changed',conflicts:[]}},
 {status:409,data:{kind:'error',code:'revision_changed',resolution:'unknown',conflicts:[]}},
 {status:401,data:{kind:'error',code:'permission_denied',resolution:'not_committed',conflicts:[]}},
 {status:429,data:{kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]}},
 {status:200,data:{kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]}},
 {status:503,data:{kind:'success',value:receipt}},
 {status:502,data:{kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]}},
 {status:200,data:{kind:'transport_error',code:'offline'}},
 {status:200,data:null},
])test('malformed or status-mismatched approval never settles '+JSON.stringify(reply),()=>{
  expect(parseGovernanceReply('approveProposal',args,reply,capability)).toEqual(indeterminate);
});
test('dispatch errors are indeterminate; only explicit pre-dispatch offline evidence becomes offline',async()=>{
  expect(await createGovernanceAPI(capability,async()=>{throw Error('private connection detail');})!.approveProposal(args)).toEqual(indeterminate);
  expect(await createGovernanceAPI(capability,async()=>({notDispatched:true}))!.approveProposal(args)).toEqual({kind:'transport_error',code:'offline'});
});
test('HTTP adapter retains error status/body without credentials in diagnostics or redirects',async()=>{
  const seen:RequestInit[]=[];
  const hub=createHttpHub('https://hub.test','fixture-token',async(_url,init)=>{seen.push(init);return Response.json({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]},{status:429,headers:{'Retry-After':'3'}});});
  const api=createGovernanceAPI(capability,hub.governancePost)!;
  expect(await api.approveProposal(args)).toEqual({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]});
  expect(seen[0]).toMatchObject({method:'POST',redirect:'error',credentials:'omit'});
});
test('the adapter snapshots arguments before dispatch and never accepts a later mutated selection',async()=>{
  let release:()=>void=()=>{};const waiting=new Promise<void>(r=>{release=r;});
  const input={...args};let sent:unknown;
  const api=createGovernanceAPI(capability,async(_route,body)=>{sent=body;await waiting;return {status:200,data:{kind:'success',value:receipt}};})!;
  const pending=api.approveProposal(input);input.expectedVersion='changed';input.idempotencyKey='replacement';release();
  expect(await pending).toEqual({kind:'success',value:receipt});expect(sent).toEqual(args);
});
test('read matrix rejects mutation errors and unlisted statuses',()=>{
  for(const status of [200,400,401,413,429,503])expect(parseGovernanceReply('historyEvents',{target},{status,data:{kind:'unavailable'},...(status===429?{retryAfterSeconds:3}:{})},capability)).toEqual({kind:'unavailable'});
  for(const status of [403,404,409,422,500])expect(parseGovernanceReply('historyEvents',{target},{status,data:{kind:'unavailable'}},capability)).toEqual(indeterminate);
});
test('page and typed-cell failures are indeterminate instead of partially accepted',()=>{
  const preview={target,revision,changes:[{column:'qty',before:{type:'integer',value:'1'},after:{type:'integer',value:'9223372036854775808'}}],selectedEventIds:[],conflicts:[],previewToken:'opaque',expiresAt:'2026-01-01T00:00:01.000Z'};
  expect(parseGovernanceReply('previewChanges',{target,intent:{kind:'patch',changes:[{column:'qty',after:{type:'integer',value:'2'}}]}},{status:200,data:{kind:'success',value:preview}},capability)).toEqual(indeterminate);
  expect(parseGovernanceReply('listProposals',{}, {status:200,data:{kind:'success',value:{proposals:[],nextCursor:5}}},capability)).toEqual(indeterminate);
});
test('enums require scalar strings and cannot be supplied as single-element arrays',()=>{
  expect(createGovernanceAPI({...capability,principal:{...actor,kind:['user']}},async()=>({status:200,data:{kind:'purged'}}))).toBeNull();
  for(const data of [
    {kind:'error',code:['revision_changed'],resolution:'not_committed',conflicts:[]},
    {kind:'error',code:'revision_changed',resolution:['not_committed'],conflicts:[]},
    {kind:'error',code:'revision_changed',resolution:'not_committed',conflicts:[{code:['unavailable'],column:null,eventIds:[],message:''}]},
  ])expect(parseGovernanceReply('approveProposal',args,{status:409,data},capability)).toEqual(indeterminate);
});
