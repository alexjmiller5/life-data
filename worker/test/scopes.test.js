import { expect, test } from 'bun:test';
import worker from '../src/index.js';
import fixture from '../../tests/fixtures/hub-capabilities-contract.json';
import { D1Shim } from './d1shim.js';

async function setup(scopes) {
  const env = {HUB_TOKEN:'operator-fixture',AUTH_DB:new D1Shim(),DB:{prepare(){throw new Error('unexpected data access');}}};
  const ctx = {waitUntil(){}};
  const mint = await worker.fetch(new Request('https://hub.test/v1/tokens/create',{
    method:'POST',headers:{Authorization:'Bearer operator-fixture'},
    body:JSON.stringify({name:'consumer-fixture',scopes:scopes.join(',')}),
  }),env,ctx);
  const {token} = await mint.json();
  const call = (path,method='GET',body) => worker.fetch(new Request(`https://hub.test${path}`,{
    method,headers:{Authorization:`Bearer ${token}`},body:body === undefined ? undefined : JSON.stringify(body),
  }),env,ctx);
  return {call,env};
}

for (const entry of fixture.sessions) test(`session capability contract: ${entry.scopes.join(',')}`,async()=>{
  const {call} = await setup(entry.scopes);
  const response = await call('/v1/session');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({name:'consumer-fixture',scopes:entry.scopes,capabilities:entry.capabilities});
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('restricted schema denial is explicit and touches no data D1',async()=>{
  const {call} = await setup(['tables:read:articles']);
  for (const path of ['/v1/schema/pull','/v1/schema/push']) {
    const response = await call(path,'POST',{});
    expect(response.status).toBe(fixture.scoped_replica_unsupported.status);
    expect(await response.json()).toEqual(fixture.scoped_replica_unsupported.body);
  }
});
