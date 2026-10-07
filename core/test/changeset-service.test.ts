import {expect,test} from 'bun:test';
import type {MutationError} from '../src/contract.generated.ts';
import {parseChangesetApproval} from '../src/changeset-service.ts';

const expected={proposalId:'p',proposalVersion:'v',principalId:'u',changes:[
  {table:'items',id:'one',kind:'create' as const},{table:'labels',id:'two',kind:'patch' as const},
]};
const value={operationId:'operation',proposalId:'p',proposalVersion:'v',approvedBy:{principalId:'u',kind:'user' as const},committedAt:'2030-01-01T00:00:00.000Z',historyEventIds:['history'],
  rows:expected.changes.map(row=>({...row,revision:{updated_at:'2030-01-01T00:00:00.000Z',hub_at:'2030-01-01T00:00:00.000Z'}}))};
const reply=(v:unknown)=>({status:200,data:{kind:'success',value:v}});

test('a whole-set approval receipt binds the displayed targets, version and authenticated user',()=>{
  expect(parseChangesetApproval(expected,reply(value))).toEqual({kind:'success',value});
});
for(const changed of [
  {...value,rows:value.rows.slice(0,1)},
  {...value,rows:[value.rows[0],value.rows[0]]},
  {...value,rows:[{...value.rows[0],table:'other'},value.rows[1]]},
  {...value,rows:[{...value.rows[0],kind:'patch'},value.rows[1]]},
  {...value,proposalVersion:'other'},
  {...value,approvedBy:{principalId:'u',kind:'agent'}},
  {...value,approvedBy:{principalId:'other',kind:'user'}},
  {...value,historyEventIds:['history','history']},
])test('partial or mismatched receipt remains indeterminate: '+JSON.stringify(changed),()=>{
  expect(parseChangesetApproval(expected,reply(changed))).toEqual({kind:'transport_error',code:'indeterminate'});
});

test('only a canonical durable rejection settles an original mutation as not committed',()=>{
  const error:MutationError={kind:'error',code:'revision_changed',resolution:'not_committed',conflicts:[]};
  expect(parseChangesetApproval(expected,{status:409,data:error})).toEqual(error);
  for(const status of [200,401,403,500,503])expect(parseChangesetApproval(expected,{status,data:error})).toEqual({kind:'transport_error',code:'indeterminate'});
  expect(parseChangesetApproval(expected,{status:409,data:{...error,code:'idempotency_conflict'}})).toEqual({kind:'transport_error',code:'indeterminate'});
});

test('ordinary auth failures and malformed responses never settle an unknown original outcome',()=>{
  const denied:MutationError={kind:'error',code:'permission_denied',resolution:'unresolved',conflicts:[]};
  expect(parseChangesetApproval(expected,{status:403,data:denied})).toEqual(denied);
  expect(parseChangesetApproval(expected,{status:500,data:{}})).toEqual({kind:'transport_error',code:'indeterminate'});
});
