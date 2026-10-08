import {expect,test} from 'bun:test';
import {captureGateway} from '../src/capture-gateway.js';
const id='11111111-1111-4111-8111-111111111111';
const tenant={hash:'opaque-token-fingerprint',scopes:['captures:submit:media','captures:read:media','tables:patch:items:saved','tables:patch:items:status']};
const env={CAPTURE_ADAPTERS:JSON.stringify({media:{url:'https://resolver.test/capture',credential:'synthetic-service-token',fields:{saved:['tables:patch:items:saved'],status:['tables:patch:items:status']}}})};
const body={request_id:id,input:{url:'https://example.test/article'},intent:'save'};
const request=(payload=body,method='POST')=>new Request('https://hub.test/v1/captures/media'+(method==='GET'?'/'+id:''),{method,headers:{Authorization:'Bearer device-secret'},...(method==='POST'?{body:JSON.stringify(payload)}:{})});

test('gateway uses fixed service credential and opaque subject, never device token',async()=>{
 let called;
 const fetcher=async(url,init)=>{called={url,init};return Response.json({request_id:id,state:'received',internal:'hidden'});};
 const response=await captureGateway(request(),tenant,env,fetcher);
 expect(response.status).toBe(202);expect(await response.json()).toEqual({request_id:id,state:'received'});
 expect(called.url).toBe('https://resolver.test/capture');expect(called.init.redirect).toBe('error');
 expect(called.init.headers.Authorization).toBe('Bearer synthetic-service-token');
 expect(JSON.stringify(called)).not.toContain('device-secret');expect(JSON.stringify(called)).not.toContain(tenant.hash);
 expect(JSON.parse(called.init.body).action).toBe('submit');
 expect(called.init.signal).toBeDefined();
});

test('read credentials cannot submit and ungranted fields fail before transport',async()=>{
 const unreachable=()=>{throw Error('must not call upstream');};
 for(const scopes of [['captures:read:media'],['captures:submit:media'],['captures:submit:other','tables:patch:items:saved']]){
  expect((await captureGateway(request(),{...tenant,scopes},env,unreachable)).status).toBe(403);
 }
 expect((await captureGateway(request({...body,fields:{status:'Finished'}}),{...tenant,scopes:tenant.scopes.filter(s=>!s.endsWith(':status'))},env,unreachable)).status).toBe(403);
});

test('caller cannot choose endpoint workspace credential category or malformed input',async()=>{
 const unreachable=()=>{throw Error('must not call upstream');};
 for(const extra of [{endpoint:'https://other.test'}, {workspace:'other'}, {credential:'root'}, {category:'tasks'}, {input:{text:'x',url:'https://example.test'}}, {intent:'delete'}]){
  expect((await captureGateway(request({...body,...extra}),tenant,env,unreachable)).status).toBe(400);
 }
});

test('receipt reads carry same isolated subject and sanitize failures',async()=>{
 const subjects=[];
 const fetcher=async(_,init)=>{const sent=JSON.parse(init.body);subjects.push(sent.subject);return Response.json({request_id:id,state:'saved',item:{kind:'article',id:'item-1'}});};
 expect((await captureGateway(request(),tenant,env,fetcher)).status).toBe(200);
 expect((await captureGateway(request(undefined,'GET'),tenant,env,fetcher)).status).toBe(200);
 expect(subjects[0]).toBe(subjects[1]);
 await captureGateway(request(),{...tenant,hash:'other'},env,fetcher);expect(subjects[2]).not.toBe(subjects[0]);
 const failed=await captureGateway(request(),tenant,env,async()=>{throw Error('secret URL credential');});
 expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('credential');
});

test('gateway rejects claimed saved without an identity and mismatched receipt ids',async()=>{
 for(const receipt of [{request_id:id,state:'saved'},{request_id:'other',state:'received'}]){
  expect((await captureGateway(request(),tenant,env,async()=>Response.json(receipt))).status).toBe(502);
 }
});

test('inferred capture edits cannot bypass grants by omitting explicit fields',async()=>{
 const narrowed={...tenant,scopes:tenant.scopes.filter(s=>!s.endsWith(':status'))};
 const response=await captureGateway(request(),narrowed,env,()=>{throw Error('must not call upstream');});
 expect(response.status).toBe(403);
});

test('capture refuses stale enrolled bindings before delegating a write',async()=>{
 const {enrollmentProfile}=await import('../src/enrollment-profile.js');
 const profileEnv={...env,ENROLLMENT_PROFILES:JSON.stringify({library:{label:'Library',scopes:[...tenant.scopes,'tables:read:items:id','tables:read:items:saved','tables:read:items:status','tables:read:items:updated_at','tables:read:items:hub_at']}})};
 const profile=await enrollmentProfile(profileEnv,'library');
 expect(profile).not.toBeNull();
 const enrolled={...tenant,scopes:profile.scopes,enrollmentProfile:{id:profile.id,revision:profile.revision}};
 profileEnv.ENROLLMENT_PROFILES='{}';
 let calls=0;
 const result=await captureGateway(request(),enrolled,profileEnv,async()=>{calls++;return Response.json({request_id:id,state:'received'});});
 expect(result.status).toBe(409);expect(calls).toBe(0);
});

test('request and reply streaming are bounded and upstream failures stay opaque',async()=>{
 let calls=0;
 const sent=await captureGateway(request({...body,input:{text:'x'.repeat(65536)}}),tenant,env,async()=>{calls++;return Response.json({});});
 expect(sent.status).toBe(400);expect(calls).toBe(0);
 let cancelled=false;
 const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;}});
 const received=await captureGateway(request(),tenant,env,async()=>new Response(stream));
 expect(received.status).toBe(502);expect(cancelled).toBe(true);
 for(const status of [401,403,500]){
  const result=await captureGateway(request(),tenant,env,async()=>new Response('private error',{status}));
  expect(result.status).toBe(503);expect(await result.text()).not.toContain('private');
 }
});

test('session advertises only configured adapters and effective grants; revoked devices lose access',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {D1Shim}=await import('./d1shim.js');
 const {ensureAuthReady,hashToken}=await import('../src/auth.js');
 const AUTH_DB=new D1Shim(),DB=new D1Shim();await ensureAuthReady(AUTH_DB);
 AUTH_DB.db.query('INSERT INTO _tokens(hash,name,scopes) VALUES (?,?,?)').run(await hashToken('device'),'fixture',tenant.scopes.join(','));
 const configured={...env,AUTH_DB,DB,HUB_TOKEN:'root'};
 const call=path=>worker.fetch(new Request('https://hub.test'+path,{headers:{Authorization:'Bearer device'}}),configured,{waitUntil(){}});
 const caps=(await (await call('/v1/session')).json()).capabilities;
 expect(caps.captures).toEqual({protocol:'receipt-v1',adapters:[{id:'media',read:true,submit:true}]});
 AUTH_DB.db.exec("UPDATE _tokens SET scopes='captures:read:media'");
 expect((await (await call('/v1/session')).json()).capabilities.captures.adapters[0].submit).toBe(false);
 AUTH_DB.db.exec("UPDATE _tokens SET revoked_at='2026-01-01'");
 expect((await call('/v1/captures/media/'+id)).status).toBe(403);
});

test('submissions wait longer than receipt reads for the adapter to accept',async()=>{
 const {UPSTREAM_TIMEOUTS}=await import('../src/capture-gateway.js');
 expect(UPSTREAM_TIMEOUTS).toEqual({read:15000,submit:60000});
 const slow=(_,init)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(Response.json({request_id:id,state:'received'})),80);
  init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal.reason);});
 });
 const budget={read:20,submit:400};
 expect((await captureGateway(request(),tenant,env,slow,budget)).status).toBe(202);
 expect((await captureGateway(request(undefined,'GET'),tenant,env,slow,budget)).status).toBe(503);
});
