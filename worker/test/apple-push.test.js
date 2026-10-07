import {expect,test,spyOn} from 'bun:test';
import hub,{authenticate,SWEEP_CRON} from '../src/index.js';
import {withUsage} from '../src/usage.js';
import {hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';
import * as push from '../src/apple-push.js';
import {notify} from '../src/usage.js';
const worker=withUsage(hub,{authenticate,sweepCron:SWEEP_CRON,deliverNotifications:async()=>{}});

const config={deploymentIdentity:'deployment-one',teamId:'TEAMTEST01',keyId:'KEYTEST001',profiles:[
  {id:'desktop',platform:'macos',topic:'org.example.desktop',environment:'production'},
  {id:'phone',platform:'ios',topic:'org.example.phone',environment:'production'}]};
const access={aud:'login-aud',getIdentity:async()=>({email:'operator@example.test'})};
function environment(){return {HUB_TOKEN:'root',DB:new D1Shim(),AUTH_DB:new D1Shim(),LOGIN_ACCESS_AUD:'login-aud',
  APNS_CONFIG:JSON.stringify(config),APNS_PRIVATE_KEY:'fixture-key'};}
async function call(env,path,{token='device-one',method='GET',body,form,implementation=worker}={}){
  const pending=[];
  const headers={Authorization:`Bearer ${token}`};
  if(form){headers.Origin='https://hub.test';headers['Content-Type']='application/x-www-form-urlencoded';}
  const r=await implementation.fetch(new Request('https://hub.test'+path,{method,headers,
    body:form?new URLSearchParams(form).toString():body===undefined?undefined:JSON.stringify(body)}),env,
    {access,waitUntil:p=>pending.push(p)});
  while(pending.length)await pending.shift();
  return r;
}
async function enroll(env,token='device-one',pushProfile='desktop'){
  const r=await call(env,'/login',{method:'POST',form:{key:await hashToken(token),name:'Synthetic installation',pushProfile}});
  expect(r.status).toBe(200);
}
const registration=(extra={})=>({appProfile:'desktop',deviceToken:'aabb',expectedRevision:null,requestId:'request-one',...extra});
async function post(env,body,path='/v1/push/registration',token='device-one'){
  const response=await call(env,path,{method:'POST',body,token});return {status:response.status,body:await response.json()};
}

test('explicit browser approval grants only the requested app profile and opaque session binding',async()=>{
  const env=environment();await enroll(env);
  const session=await (await call(env,'/v1/session')).json();
  const capability=session.capabilities.push_registration;
  expect(capability).toMatchObject({protocol:'apns-registration-v1',deploymentIdentity:'deployment-one',profiles:[{id:'desktop',platform:'macos'}]});
  expect(capability.sessionBinding).toBeString();
  expect(capability.sessionBinding).not.toContain(await hashToken('device-one'));
  expect((await post(env,registration({appProfile:'phone'}))).body).toEqual({kind:'unavailable'});
  expect((await post(env,registration(),undefined,'root')).body).toEqual({kind:'unavailable'});
});

test('registration uses CAS, retries the exact current receipt and rejects old receipts after rotation',async()=>{
  const env=environment();await enroll(env);
  const before=await (await call(env,'/v1/push/registration?appProfile=desktop')).json();
  expect(before).toEqual({kind:'available',registration:null});
  const first=await post(env,registration());expect(first.body.kind).toBe('confirmed');
  expect(await post(env,registration())).toEqual(first);
  expect(JSON.stringify(first.body)).not.toContain('aabb');
  expect((await post(env,registration({deviceToken:'ccdd'}))).body).toEqual({kind:'conflict',code:'request_reused'});
  const next=await post(env,registration({deviceToken:'ccdd',expectedRevision:first.body.receipt.registration.revision,requestId:'rotate'}));
  expect(next.body.kind).toBe('confirmed');
  expect(next.body.receipt.registration.installationId).toBe(first.body.receipt.registration.installationId);
  expect(next.body.receipt.registration.revision).not.toBe(first.body.receipt.registration.revision);
  expect((await post(env,registration())).body).toEqual({kind:'conflict',code:'registration_changed'});
});

test('absent revoke prevents late create and only a fresh explicit register intent reactivates',async()=>{
  const env=environment();await enroll(env);
  const revoke={appProfile:'desktop',expectedRevision:null,requestId:'revoke'};
  const barrier=await post(env,revoke,'/v1/push/registration/revoke');
  expect(barrier.body.receipt.registration.state).toBe('revoked');
  expect((await post(env,registration())).status).toBe(409);
  const active=await post(env,registration({expectedRevision:barrier.body.receipt.registration.revision,requestId:'reactivate'}));
  expect(active.body.receipt.registration.state).toBe('active');
  expect((await post(env,revoke,'/v1/push/registration/revoke')).status).toBe(409);
});

test('create-first revoke reconciles through current revision; logout removes authority',async()=>{
  const env=environment();await enroll(env);
  const first=await post(env,registration());
  expect((await post(env,{appProfile:'desktop',expectedRevision:null,requestId:'revoke'},'/v1/push/registration/revoke')).status).toBe(409);
  const revoked=await post(env,{appProfile:'desktop',expectedRevision:first.body.receipt.registration.revision,requestId:'revoke-current'},'/v1/push/registration/revoke');
  expect(revoked.body.receipt.registration.state).toBe('revoked');
  expect((await post(env,registration())).status).toBe(409);
  await call(env,'/v1/session',{method:'POST',body:{}});
  expect((await post(env,registration())).status).toBe(401);
});

test('device installations stay isolated, legacy and named operator tokens never acquire push provenance',async()=>{
  const env=environment();await enroll(env);await enroll(env,'device-two');
  const first=await post(env,registration());
  const second=await post(env,registration(),undefined,'device-two');
  expect(first.body.receipt.registration.installationId).not.toBe(second.body.receipt.registration.installationId);
  const legacy='legacy';
  expect((await call(env,'/login',{method:'POST',form:{key:await hashToken(legacy),name:'Synthetic legacy'}})).status).toBe(200);
  expect((await (await call(env,'/v1/session',{token:legacy})).json()).capabilities.push_registration).toBeUndefined();
});

test('request validation rejects client authority and malformed token bytes',async()=>{
  const env=environment();await enroll(env);
  for(const extra of [{principal:'other'},{deploymentIdentity:'other'},{topic:'org.other'},{installationId:'other'},
    {deviceToken:'AABB'},{deviceToken:'abc'},{deviceToken:''},{expectedRevision:42},{requestId:''}]){
    expect((await post(env,registration(extra))).status).toBe(400);
  }
});

test('exact registration routes stay available at the data cap without accessing data storage',async()=>{
  const env=environment();await enroll(env);
  env.USAGE_LIMITS=JSON.stringify({d1_rows_read:{allowance:1,cap:0,alert_at:[]}});
  env.DB={prepare(){throw Error('push touched personal data storage');},batch(){throw Error('push touched personal data storage');}};
  expect((await post(env,registration())).body.kind).toBe('confirmed');
  expect((await call(env,'/v1/push/registration?appProfile=desktop')).status).toBe(200);
  expect((await call(env,'/v1/push/unknown',{method:'POST',body:{}})).status).toBe(429);
  expect((await call(env,'/v1/push/registration',{method:'DELETE'})).status).toBe(429);
});

async function providerEnvironment(){
  const env=environment();
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  env.APNS_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',key.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
  await enroll(env);await post(env,registration());return env;
}
const event=(id='event-one')=>({id,producer:'test',type:'synthetic',severity:'info',title:'Synthetic alert',body:'Synthetic message',data:{}});
test('sender uses canonical identity, advances only delivery receipt, and never changes shared read state',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  const requests=[];
  await push.deliverPush?.(env,async(url,options)=>{requests.push({url,options});return new Response(null,{status:200});});
  expect(requests).toHaveLength(1);
  const {url,options}=requests[0];
  expect(url).toBe('https://api.push.apple.com/3/device/aabb');
  expect(options.headers['apns-topic']).toBe('org.example.desktop');
  expect(options.headers['apns-push-type']).toBe('alert');
  expect(options.headers['apns-collapse-id']).toHaveLength(43);
  expect(options.redirect).toBe('error');
  expect(JSON.parse(options.body)).toEqual({aps:{alert:{title:'Synthetic alert',body:'Synthetic message'},sound:'default'},lifeNotification:{deploymentIdentity:'deployment-one',eventId:'event-one'}});
  expect(await env.AUTH_DB.prepare('SELECT read_at FROM _notifications').first()).toEqual({read_at:null});
  await push.deliverPush?.(env,async()=>{throw Error('accepted event replayed');});
});

test('retryable rejection survives a new sender invocation and keeps read/checkpoint independent',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  let attempts=0;
  const send=async()=>{attempts++;return new Response(null,{status:attempts===1?503:200});};
  await push.deliverPush?.(env,send,100000);
  expect(attempts).toBe(1);
  await push.deliverPush?.(env,send,100001);expect(attempts).toBe(1);
  await push.deliverPush?.(env,send,200000);expect(attempts).toBe(2);
  expect(await env.AUTH_DB.prepare('SELECT read_at FROM _notifications').first()).toEqual({read_at:null});
});

test('old invalid-token response cannot revoke a newly rotated registration',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  const before=await (await call(env,'/v1/push/registration?appProfile=desktop')).json();
  let sent=0;
  await push.deliverPush?.(env,async()=>{
    sent++;
    const rotated=await post(env,registration({deviceToken:'ccdd',expectedRevision:before.registration.revision,requestId:'rotate'}));
    expect(rotated.body.kind).toBe('confirmed');
    return Response.json({reason:'Unregistered',timestamp:Date.now()},{status:410});
  });
  expect(sent).toBe(1);
  const after=await (await call(env,'/v1/push/registration?appProfile=desktop')).json();
  expect(after.registration.state).toBe('active');
  expect(after.registration.revision).not.toBe(before.registration.revision);
});

test('logout while signing the provider token stops dispatch',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  const original=crypto.subtle.sign.bind(crypto.subtle);
  const previous=crypto.subtle.sign;
  crypto.subtle.sign=async(...args)=>{
    await call(env,'/v1/session',{method:'POST',body:{}});
    return original(...args);
  };
  let sent=0;
  try{await push.deliverPush(env,async()=>{sent++;return new Response(null,{status:200});});}
  finally{crypto.subtle.sign=previous;}
  expect(sent).toBe(0);
});

test('transport keys match the frozen Swift cross-language vectors',async()=>{
  const vectors=[
    ['https://one.invalid/api/','event-8','4BdNs7CMh0vV4eEB52YGG26j7b_S8dqO4Z1GyS-d4DU'],
    ['deployment-quote"\\\n\t','event\0\b\f\r\u001f','XxI9zJU9Iqk1cpNo1lQXV5XT-6D29fMH55F-MX0-p5k'],
    ['deployment-😀','🔔/雪','s7oGa6WrCaXRMMRbf8iKhIDv2imYRW8YwpUC3hty6kg'],
    ['deployment','\u00e9','w4lQtBKfabodAkIqfG9eCHMpiZ8cWYNXLk1W0lnJi6c'],
    ['deployment','e\u0301','s2UoNajTn_BmG93Rw_k0K52c208ejqJfYpDayzF0pOo'],
    ['a','bc','RxZ_S5jlAKIGmpDwu0lnFKGegNK2Sag-zfjZ0X5VGuA'],
    ['ab','c','iEca4rpRIzmhgjjPSqa10kpW62iu7HSGCFOv3JJj7LU'],
    ['deployment','line\u2028paragraph\u2029','wTW9s-NvgrqQTbdH4Y0f7Ye0p1gheTwJfpSx6F-boIc']];
  for(const [deployment,id,key] of vectors)expect(await push.pushIdentity(deployment,id)).toBe(key);
});

test('browser approval page makes push consent explicit without enrolling on GET',async()=>{
  const env=environment();
  const response=await call(env,`/login?key=${await hashToken('device-one')}&name=Synthetic&pushProfile=desktop`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Allow Apple push notifications');
  expect((await env.AUTH_DB.prepare("SELECT name FROM sqlite_master WHERE name='_push_enrollments'").all()).results).toEqual([]);
});

test('deployed usage wrapper drains push delivery after accounting without changing the feed read state',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  let sent=0;
  const implementation=withUsage(hub,{authenticate,sweepCron:SWEEP_CRON,
    deliverNotifications:e=>push.deliverPush(e,async()=>{sent++;return new Response(null,{status:200});})});
  await call(env,'/v1/notifications',{implementation});
  expect(sent).toBe(1);
  expect(await env.AUTH_DB.prepare('SELECT read_at FROM _notifications').first()).toEqual({read_at:null});
});

test('one drain delivers a bounded backlog without starving installations behind idle ones',async()=>{
  const env=await providerEnvironment();
  for(let n=0;n<21;n++){
    const token=`idle-${n}`;await enroll(env,token);
    await post(env,registration(),undefined,token);
  }
  await notify(env.AUTH_DB,event('one'));await notify(env.AUTH_DB,event('two'));
  // Only the final installation has undelivered work.
  await env.AUTH_DB.prepare("UPDATE _push_registrations SET delivery_cursor=2 WHERE token_hash<>?").bind(await hashToken('idle-20')).run();
  const ids=[];
  await push.deliverPush(env,async(_url,options)=>{ids.push(JSON.parse(options.body).lifeNotification.eventId);return new Response(null,{status:200});});
  expect(ids).toEqual(['one','two']);
});

test('provider signing failures have durable backoff and valid tokens are reused',async()=>{
  const broken=environment();await enroll(broken);await post(broken,registration());await notify(broken.AUTH_DB,event());
  await push.deliverPush(broken,async()=>{throw Error('invalid provider key sent');},100000);
  expect(await broken.AUTH_DB.prepare('SELECT outcome,next_attempt FROM _push_deliveries').first()).toEqual({outcome:'retry',next_attempt:130000});
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  const tokens=[];
  const send=async(_url,options)=>{tokens.push(options.headers.authorization);return new Response(null,{status:200});};
  await push.deliverPush(env,send,100000);
  await notify(env.AUTH_DB,event('next'));
  await push.deliverPush(env,send,200000);
  expect(tokens).toHaveLength(2);expect(tokens[0]).toBe(tokens[1]);
});
test('legacy device can discover public profiles before explicit approval without gaining authority',async()=>{
  const env=environment();
  await call(env,'/login',{method:'POST',form:{key:await hashToken('device-one'),name:'Existing label'}});
  const before=await (await call(env,'/v1/session')).json();
  expect(before.capabilities.push_profiles).toEqual([{id:'desktop',platform:'macos'},{id:'phone',platform:'ios'}]);
  expect(before.capabilities.push_registration).toBeUndefined();
  expect((await post(env,registration())).body.kind).toBe('unavailable');
  await enroll(env);
  expect((await post(env,registration())).body.kind).toBe('confirmed');
  expect(await env.AUTH_DB.prepare('SELECT label FROM _tokens WHERE hash=?').bind(await hashToken('device-one')).first()).toEqual({label:'Existing label'});
});
test('another window confirming the same token preserves its current registration generation',async()=>{
  const env=environment();await enroll(env);
  const first=await post(env,registration());
  const same=await post(env,registration({expectedRevision:first.body.receipt.registration.revision,requestId:'other-window'}));
  expect(same.body.receipt.registration.revision).toBe(first.body.receipt.registration.revision);
  expect((await post(env,registration())).body.kind).toBe('confirmed');
});
test('same-token confirmation cannot release another in-flight delivery lease',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  const before=await (await call(env,'/v1/push/registration?appProfile=desktop')).json();
  let duplicate=0;
  await push.deliverPush(env,async()=>{
    await post(env,registration({expectedRevision:before.registration.revision,requestId:'other-window'}));
    await push.deliverPush(env,async()=>{duplicate++;return new Response(null,{status:200});});
    return new Response(null,{status:200});
  });
  expect(duplicate).toBe(0);
});

test('provider refusal diagnostic reports only allowlisted status and reason',async()=>{
  const env=await providerEnvironment();await notify(env.AUTH_DB,event());
  const warn=spyOn(console,'warn').mockImplementation(()=>{});
  try{
    await push.deliverPush(env,async()=>Response.json({reason:'InvalidProviderToken',private:'secret-device-token'},{status:403}));
    expect(warn.mock.calls).toEqual([['APNs delivery refused',403,'InvalidProviderToken']]);
    warn.mockClear();
    await push.deliverPush(env,async()=>Response.json({reason:'secret-device-token'},{status:403}),Date.now()+60000);
    expect(warn.mock.calls).toEqual([['APNs delivery refused',403,'Other']]);
  }finally{warn.mockRestore();}
});
