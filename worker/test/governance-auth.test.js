import { expect, test } from 'bun:test';
import worker from '../src/main.js';
import hub, { authenticate } from '../src/index.js';
import { hashToken } from '../src/auth.js';
import { D1Shim } from './d1shim.js';
import { ensureUsage, period } from '../src/usage.js';

const access={aud:'test-audience',getIdentity:async()=>({email:'owner@example.test'})};
function fixture(){return {DB:new D1Shim(),AUTH_DB:new D1Shim(),HUB_TOKEN:'operator-secret',LOGIN_ACCESS_AUD:'test-audience'};}
const req=(path,token='consumer-token',body={})=>new Request('https://hub.test'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function enroll(env,token='consumer-token'){
  return hub.fetch(new Request('https://hub.test/login',{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({key:await hashToken(token),name:'Synthetic device'})}),env,{access,waitUntil(){}});
}
async function snapshots(env){
  return Promise.all([env.DB,env.AUTH_DB].map(async db=>{
    const {results}=await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    return Promise.all(results.map(async ({name,sql})=>({sql,rows:(await db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()).results})));
  }));
}

test('cold and denied preview goes through real usage wrapper without persistent initialization or waitUntil',async()=>{
  const env=fixture(),pending=[];
  const before=await snapshots(env);
  const response=await worker.fetch(req('/v1/governance/preview'),env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({kind:'unavailable'});
  expect(pending).toEqual([]);
  expect(await snapshots(env)).toEqual(before);
});

test('verified browser enrollment supplies opaque user authority; previews never record usage or initialize data',async()=>{
  const env=fixture();expect((await enroll(env)).status).toBe(200);
  const request=req('/v1/governance/preview');
  const pending=[];
  const before=await snapshots(env);
  const tenant=await authenticate(request,env,{waitUntil:p=>pending.push(p)});
  expect(tenant.governance).toMatchObject({actor:{kind:'user'},propose:true,approve:true});
  expect(tenant.governance.actor.principalId).not.toBe(await hashToken('consumer-token'));
  const response=await worker.fetch(request,env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({kind:'unavailable'});
  expect(pending).toEqual([]);
  expect(await snapshots(env)).toEqual(before);
});

test('operator-created credential cannot claim user authority, including device-looking name and full scope',async()=>{
  const env=fixture();
  const response=await hub.fetch(req('/v1/tokens/create','operator-secret',{name:'device:'+'a'.repeat(64),scopes:'full',kind:'user',approve:true}),env,{waitUntil(){}});
  const {token}=await response.json();
  const tenant=await authenticate(req('/v1/governance/preview',token),env,{waitUntil(){}});
  expect(tenant.governance).toMatchObject({actor:{kind:'agent'},propose:true,approve:false});
  expect((await authenticate(req('/v1/governance/preview','operator-secret'),env,{waitUntil(){}})).governance).toBeNull();
});

test('legacy authority is absent, revoked authority and token revocation are read live',async()=>{
  const env=fixture();await enroll(env);
  const hash=await hashToken('consumer-token');
  const read=()=>authenticate(req('/v1/governance/preview'),env,{waitUntil(){throw Error('preview side effect');}});
  await env.AUTH_DB.prepare("UPDATE _governance_authorities SET revoked_at='revoked' WHERE token_hash=?").bind(hash).run();
  expect((await read()).governance).toBeNull();
  await env.AUTH_DB.prepare('DELETE FROM _governance_authorities').run();
  expect((await read()).governance).toBeNull();
  await env.AUTH_DB.prepare("UPDATE _tokens SET revoked_at='revoked' WHERE hash=?").bind(hash).run();
  expect(await read()).toBeNull();
});

test('approval without authentication returns unresolved permission denial, never original-operation settlement',async()=>{
  const env=fixture(),pending=[];
  const response=await worker.fetch(req('/v1/governance/proposals/approve'),env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({kind:'error',code:'permission_denied',resolution:'unresolved',conflicts:[]});
});

test('at-cap preview preserves both stores and approval denial keeps the original operation unresolved',async()=>{
  const env=fixture();await enroll(env);await ensureUsage(env.AUTH_DB);
  env.USAGE_LIMITS=JSON.stringify({d1_rows_read:{cap:1}});
  await env.AUTH_DB.prepare('INSERT INTO _usage (period,principal,rows_read,rows_written,requests,updated_at) VALUES (?,?,1,0,1,?)')
    .bind(period(new Date()).start,'synthetic-principal',new Date().toISOString()).run();
  const before=await snapshots(env),pending=[];
  for(const path of ['/v1/governance/preview','/v1/governance/proposals/preview']){
    const response=await worker.fetch(req(path),env,{waitUntil:p=>pending.push(p)});
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({kind:'unavailable'});
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(pending).toEqual([]);
  expect(await snapshots(env)).toEqual(before);
  const response=await worker.fetch(req('/v1/governance/proposals/approve'),env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]});
  expect((await snapshots(env))[0]).toEqual(before[0]);
});

test('agent approval and revoked-user retries cannot reach a data writer',async()=>{
  const env=fixture();await enroll(env);
  const response=await hub.fetch(req('/v1/tokens/create','operator-secret',{name:'synthetic-agent',scopes:'full'}),env,{waitUntil(){}});
  const {token}=await response.json();
  const pending=[];
  const denied=await worker.fetch(req('/v1/governance/proposals/approve',token),env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({kind:'error',code:'permission_denied',resolution:'unresolved',conflicts:[]});
  const authority=await authenticate(req('/v1/governance/preview'),env,{waitUntil(){}});
  await env.AUTH_DB.prepare("UPDATE _tokens SET revoked_at='revoked' WHERE hash=?").bind(authority.hash).run();
  const before=await snapshots(env),previewPending=[];
  const preview=await worker.fetch(req('/v1/governance/proposals/preview'),env,{waitUntil:p=>previewPending.push(p)});
  expect(preview.status).toBe(401);
  expect(previewPending).toEqual([]);
  expect(await snapshots(env)).toEqual(before);
  expect(before[0]).toEqual([]);
});
