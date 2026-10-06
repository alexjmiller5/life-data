import {expect,test} from 'bun:test';
import {validateCreationReceipt,validateCreationSession} from '../src/creation.ts';
import type {RowCreationRequest} from '../src/contract.generated.ts';
const revision='a'.repeat(64),policy={id:'fixture',revision};
const request={policy,sourceId:'source-1',occurrenceKey:2030,target:{kind:'generated',id:'a'.repeat(32)},updatedAt:'2026-01-01T00:00:00.000Z',values:{title:'synthetic'}} as RowCreationRequest;
const receipt={kind:'created' as const,policy,id:request.target.id,revision:{updated_at:request.updatedAt,hub_at:'2026-01-02T00:00:00.000Z'},originId:'fixture:source-1:'+request.target.id};
const existing={kind:'existing' as const,policy,id:request.target.id};
test('strict created/existing receipts bind the exact submitted target and policy',()=>{
 expect(validateCreationReceipt(request,{status:200,data:receipt})).toEqual(receipt);
 expect(validateCreationReceipt(request,{status:200,data:existing})).toEqual(existing);
});
for(const data of [null,{},[],{...receipt,kind:'unknown'},{...receipt,id:'other'},{...receipt,policy:{...policy,revision:'b'.repeat(64)}},
 {...receipt,revision:{...receipt.revision,updated_at:'2026-01-03T00:00:00.000Z'}},{...receipt,revision:{updated_at:request.updatedAt,hub_at:null}},
 {...receipt,originId:''},{...receipt,originId:'other-target'}, {...existing,originId:receipt.originId},
 ...['extra:segments','!','x'.repeat(65)].map(prefix=>({...receipt,originId:prefix+':source-1:'+request.target.id})),
 {...existing,revision:receipt.revision},{...existing,policy:{...policy,extra:true}},{...receipt,inserted:[request.target.id]},
 {error:'creation_conflict'},{kind:'created',policy,id:request.target.id},
])test('missing, contradictory or mismatched result is never success: '+JSON.stringify(data),()=>{
 expect(validateCreationReceipt(request,{status:200,data})).toBeNull();
});
for(const status of [201,204,400,401,403,409,422,429,500,503])test('noncanonical status does not settle success: '+status,()=>{
 expect(validateCreationReceipt(request,{status,data:receipt})).toBeNull();
});
test('adopted intent can never accept a created receipt',()=>{
 expect(validateCreationReceipt({...request,target:{kind:'adopted',id:request.target.id}},{status:200,data:receipt})).toBeNull();
 expect(validateCreationReceipt({...request,target:{kind:'adopted',id:request.target.id}},{status:200,data:existing})).toEqual(existing);
});
const scopes=[`rows:create:fixture:${revision}`,'tables:read:sources:id'];
const session={scopes,capabilities:{rowCreation:{protocol:'atomic-origin-v1',policies:[policy]}}};
test('current exact policy and grant set are necessary for session readiness',()=>{
 expect(validateCreationSession({status:200,data:session},policy,scopes)).toBe(true);
 for(const data of [{...session,scopes:[...scopes,'full']},{...session,capabilities:{}},{...session,capabilities:{...session.capabilities,governance:{}}},
 {...session,capabilities:{rowCreation:{protocol:'unknown',policies:[policy]}}},{...session,capabilities:{rowCreation:{protocol:'atomic-origin-v1',policies:[{...policy,revision:'b'.repeat(64)}]}}}])
 expect(validateCreationSession({status:200,data},policy,scopes)).toBe(false);
 expect(validateCreationSession({status:401,data:session},policy,scopes)).toBe(false);
});

test('creation readiness never accepts a writer or invented policy even in injected expectations',()=>{
 for(const extra of ['tables:write:items','tables:read:items','files:write:captures/','rows:create:other:'+revision]) {
  const expected=[...scopes,extra];expect(validateCreationSession({status:200,data:{...session,scopes:expected}},policy,expected)).toBe(false);
 }
 expect(validateCreationSession({status:200,data:{...session,capabilities:{rowCreation:{protocol:'atomic-origin-v1',policies:[policy,{id:'other',revision}]}}}},policy,scopes)).toBe(false);
});
