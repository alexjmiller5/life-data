import {test,expect} from 'bun:test';
import {createChangesetAPI,isChangesetCapability} from '../src/changeset-client.ts';
import {createHttpHub} from '../src/http.ts';
const cap={protocol:'bounded-changeset-proposals-v1',deploymentId:'deploy',sessionId:'session',principal:{kind:'user',principalId:'p'},authority:{propose:true,approve:true},limits:{maxOperations:64,maxTables:8,maxBytes:65536,maxReadSets:64,maxMembershipRows:20000,maxReadRows:2000,previewTtlSeconds:300}};
const input={operations:[{kind:'create',table:'items',id:'a',expected_revision:null,values:{label:'x'}}],reads:[]};
const changes=[{table:'items',id:'a',kind:'create',before:null,after:{label:'x'}}];
const preview={changes,previewToken:'opaque',expiresAt:'2099-01-01T00:00:00.000Z'};
test('requires the separate exact capability and USER approval identity',()=>{
  expect(isChangesetCapability(cap)).toBe(true);
  expect(createChangesetAPI({...cap,protocol:'selected-inverse-proposals-v1'},async()=>({status:200,data:{}}))).toBeNull();
  expect(createChangesetAPI({...cap,principal:{kind:'agent',principalId:'p'}},async()=>({status:200,data:{}}))).toBeNull();
});
test('preview sends only a bounded frozen request and checks complete returned membership',async()=>{
  let sent:unknown;const api=createChangesetAPI(cap,async(route,body)=>{sent={route,body};return {status:200,data:{kind:'success',value:preview}};})!;
  expect((await api.preview(input)).kind).toBe('success');expect(sent).toEqual({route:'/v1/governance/changesets/preview',body:input});
  const wrong=createChangesetAPI(cap,async()=>({status:200,data:{kind:'success',value:{...preview,changes:[]}}}))!;
  expect(await wrong.preview(input)).toEqual({kind:'transport_error',code:'indeterminate'});
});
test('invalid and over-limit inputs never dispatch',async()=>{
  let calls=0;const api=createChangesetAPI(cap,async()=>{calls++;throw Error();})!;
  expect((await api.preview({...input,operations:[]})).kind).toBe('error');
  expect((await api.preview({...input,operations:Array(65).fill(input.operations[0])})).kind).toBe('error');expect(calls).toBe(0);
});
test('read failure and uncertain dispatched outcomes are distinct',async()=>{
  const api=createChangesetAPI(cap,async()=>{throw Error('private detail');})!;
  expect(await api.getProposal({proposalId:'a'})).toEqual({kind:'transport_error',code:'indeterminate'});
  const offline=createChangesetAPI(cap,async()=>({notDispatched:true}))!;
  expect(await offline.getProposal({proposalId:'a'})).toEqual({kind:'transport_error',code:'offline'});
});
test('approval uses the captured proposal membership and denies agent dispatch',async()=>{
  const proposal={id:'proposal',version:'v1',state:'pending',input,changes,dependencies:'hash',proposedBy:cap.principal,claimedOrigin:null,createdAt:preview.expiresAt,updatedAt:preview.expiresAt};
  const request={proposalId:'proposal',expectedVersion:'v1',previewToken:'opaque',idempotencyKey:'key'};
  let calls=0;const transport=async()=>{calls++;return {status:200,data:{kind:'success',value:{operationId:'op',proposalId:'proposal',proposalVersion:'v1',rows:[{table:'items',id:'a',kind:'create',revision:{updated_at:preview.expiresAt,hub_at:preview.expiresAt}}],historyEventIds:['history'],approvedBy:cap.principal,committedAt:preview.expiresAt}}};};
  const api=createChangesetAPI(cap,transport)!;
  expect((await api.approveProposal(request,proposal)).kind).toBe('success');
  expect((await api.approveProposal({...request,expectedVersion:'other'},proposal)).kind).toBe('error');expect(calls).toBe(1);
  const agent=createChangesetAPI({...cap,authority:{propose:true,approve:false},principal:{kind:'agent',principalId:'a'}},transport)!;
  expect((await agent.approveProposal(request,proposal)).kind).toBe('error');expect(calls).toBe(1);
});
test('HTTP seam restricts changeset routes and preserves negative receipt bodies',async()=>{
  let sent:unknown;const hub=createHttpHub('https://example.test','opaque',async(url,init)=>{sent={url,init};return Response.json({kind:'error',code:'revision_changed',resolution:'not_committed',conflicts:[]},{status:409});});
  expect(await hub.changesetPost!('/v1/governance/changesets/proposals/approve',{})).toMatchObject({status:409});
  expect(sent).toMatchObject({url:'https://example.test/v1/governance/changesets/proposals/approve',init:{redirect:'error',credentials:'omit'}});
  await expect(hub.changesetPost!('/unrecognized' as never,{})).rejects.toThrow();
});
