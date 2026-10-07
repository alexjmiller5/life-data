import {sha256hex} from './validate.js';
import {ensureUsage} from './usage.js';

const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const unavailable=()=>json({kind:'unavailable'});
const validText=value=>typeof value==='string' && value.length>0 && value.length<=128 && !/[\u0000-\u001f\u007f]/.test(value);

export function pushConfiguration(env){
  try{
    const c=JSON.parse(env.APNS_CONFIG);
    if(!env.APNS_PRIVATE_KEY || !validText(c.deploymentIdentity) || !/^[A-Z0-9]{10}$/.test(c.teamId)
      || !/^[A-Z0-9]{10}$/.test(c.keyId) || !Array.isArray(c.profiles) || !c.profiles.length
      || c.profiles.length>16 || new Set(c.profiles.map(p=>p.id)).size!==c.profiles.length
      || c.profiles.some(p=>!validText(p.id)||!['ios','macos'].includes(p.platform)
        || !/^[A-Za-z0-9.-]{1,255}$/.test(p.topic)||!['production','sandbox'].includes(p.environment)))return null;
    return c;
  }catch{return null;}
}

const initialized = new WeakMap();
export async function ensurePush(db){
  if(initialized.has(db))return initialized.get(db);
  const pending=initializePush(db).catch(error=>{initialized.delete(db);throw error;});
  initialized.set(db,pending);
  return pending;
}
async function initializePush(db){
  await ensureUsage(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS _push_enrollments (
      token_hash TEXT NOT NULL, app_profile TEXT NOT NULL, session_binding TEXT NOT NULL,
      PRIMARY KEY(token_hash,app_profile))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS _push_registrations (
      token_hash TEXT NOT NULL, app_profile TEXT NOT NULL, installation_id TEXT UNIQUE NOT NULL,
      revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')),
      device_token TEXT, activated_after_seq INTEGER NOT NULL, delivery_cursor INTEGER NOT NULL,
      updated_at TEXT NOT NULL, delivery_lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(token_hash,app_profile))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS _push_requests (
      token_hash TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      app_profile TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(token_hash,request_id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS _push_deliveries (
      installation_id TEXT NOT NULL,event_id TEXT NOT NULL,revision TEXT NOT NULL,
      outcome TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,
      PRIMARY KEY(installation_id,event_id))`),
  ]);
}

// Called only inside the existing Access-verified browser approval transaction.
// A client profile name, token name or full scope never grants this provenance.
export function pushEnrollmentStatement(db,hash,name,scopes,profile,enrollmentProfile,enrollmentRevision){
  return db.prepare(`INSERT INTO _push_enrollments(token_hash,app_profile,session_binding)
    SELECT hash,?,? FROM _tokens WHERE hash=? AND name=? AND scopes=? AND revoked_at IS NULL
      AND enrollment_profile IS ? AND enrollment_revision IS ?
    ON CONFLICT(token_hash,app_profile) DO NOTHING`)
    .bind(profile,crypto.randomUUID(),hash,name,scopes,enrollmentProfile,enrollmentRevision);
}

async function enrollments(env,tenant){
  const c=pushConfiguration(env);
  if(!c || !tenant?.hash || tenant.admin)return null;
  await ensurePush(env.AUTH_DB);
  const {results}=await env.AUTH_DB.prepare(`SELECT e.* FROM _push_enrollments e
    JOIN _tokens t ON t.hash=e.token_hash WHERE e.token_hash=? AND t.revoked_at IS NULL`).bind(tenant.hash).all();
  return {configuration:c,rows:results};
}

export async function pushCapability(env,tenant){
  const e=await enrollments(env,tenant);
  if(!e)return null;
  // One native app profile per capability/session binding. A second platform
  // needs its own native device enrollment, never the same consumer credential.
  const profiles=e.configuration.profiles.filter(p=>e.rows.some(r=>r.app_profile===p.id));
  if(profiles.length!==1)return null;
  const row=e.rows.find(r=>r.app_profile===profiles[0].id);
  return {protocol:'apns-registration-v1',deploymentIdentity:e.configuration.deploymentIdentity,
    sessionBinding:row.session_binding,profiles:profiles.map(({id,platform})=>({id,platform}))};
}

export function pushRegistrationRoute(request){
  const path=new URL(request.url).pathname;
  return (path==='/v1/push/registration' && ['GET','POST'].includes(request.method))
    || (path==='/v1/push/registration/revoke' && request.method==='POST');
}

function publicState(row,cap){
  return {installationId:row.installation_id,revision:row.revision,state:row.state,
    deploymentIdentity:cap.deploymentIdentity,sessionBinding:cap.sessionBinding,appProfile:row.app_profile,
    activatedAfterSeq:row.activated_after_seq,updatedAt:row.updated_at};
}

export async function handlePushRegistration(request,tenant,env){
  if(!tenant)return json({error:'unauthorized'},401);
  const cap=await pushCapability(env,tenant);
  if(!cap)return unavailable();
  const url=new URL(request.url),db=env.AUTH_DB;
  if(request.method==='GET'){
    if([...url.searchParams.keys()].length!==1 || !url.searchParams.has('appProfile'))return json({error:'invalid request'},400);
    const profile=url.searchParams.get('appProfile');
    if(!cap.profiles.some(p=>p.id===profile))return unavailable();
    const row=await db.prepare('SELECT * FROM _push_registrations WHERE token_hash=? AND app_profile=?').bind(tenant.hash,profile).first();
    return json({kind:'available',registration:row?publicState(row,cap):null});
  }
  const revoke=url.pathname.endsWith('/revoke');
  let body;
  try{
    const reader=request.body?.getReader();if(!reader)throw Error();
    let size=0;const chunks=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>4096)throw Error();chunks.push(value);}}
    finally{await reader.cancel();reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch{return json({error:'invalid request'},400);}
  const keys=revoke?['appProfile','expectedRevision','requestId']:['appProfile','deviceToken','expectedRevision','requestId'];
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==keys.length
    || !keys.every(k=>Object.hasOwn(body,k)) || !validText(body.appProfile) || !validText(body.requestId)
    || !(body.expectedRevision===null || validText(body.expectedRevision))
    || (!revoke && (typeof body.deviceToken!=='string'||! /^(?:[a-f0-9]{2}){1,512}$/.test(body.deviceToken))))return json({error:'invalid request'},400);
  if(!cap.profiles.some(p=>p.id===body.appProfile))return unavailable();
  const fingerprint=await sha256hex(JSON.stringify([url.pathname,...keys.map(k=>body[k])]));
  const revision=crypto.randomUUID(),installation=crypto.randomUUID();
  const state=revoke?'revoked':'active',token=revoke?null:body.deviceToken;
  const stamp=new Date().toISOString();
  const authorized=`EXISTS(SELECT 1 FROM _tokens t JOIN _push_enrollments e ON e.token_hash=t.hash
    WHERE t.hash=? AND t.revoked_at IS NULL AND e.app_profile=? AND e.session_binding=?)`;
  const noReceipt=`NOT EXISTS(SELECT 1 FROM _push_requests WHERE token_hash=? AND request_id=?)`;
  // All predicates and the receipt execute under one auth-store transaction.
  // The feed is in this same store; no personal data database is accessed.
  const cursor=`(SELECT coalesce(max(seq),0) FROM _notifications)`;
  const change=body.expectedRevision===null
    ? db.prepare(`INSERT INTO _push_registrations
      (token_hash,app_profile,installation_id,revision,state,device_token,activated_after_seq,delivery_cursor,updated_at)
      SELECT ?,?,?,?,?,?,${cursor},${cursor},? WHERE ${authorized} AND ${noReceipt}
      ON CONFLICT(token_hash,app_profile) DO NOTHING`)
      .bind(tenant.hash,body.appProfile,installation,revision,state,token,stamp,
        tenant.hash,body.appProfile,cap.sessionBinding,tenant.hash,body.requestId)
    : db.prepare(`UPDATE _push_registrations SET revision=CASE WHEN state='active' AND ?='active' AND device_token=? THEN revision ELSE ? END,state=?,device_token=?,updated_at=?,
      delivery_lease=CASE WHEN state='active' AND ?='active' AND device_token=? THEN delivery_lease ELSE NULL END,
      lease_until=CASE WHEN state='active' AND ?='active' AND device_token=? THEN lease_until ELSE 0 END,
      activated_after_seq=CASE WHEN state='revoked' AND ?='active' THEN ${cursor} ELSE activated_after_seq END,
      delivery_cursor=CASE WHEN state='revoked' AND ?='active' THEN ${cursor} ELSE delivery_cursor END
      WHERE token_hash=? AND app_profile=? AND revision=? AND ${authorized} AND ${noReceipt}`)
      .bind(state,token,revision,state,token,stamp,state,token,state,token,state,state,tenant.hash,body.appProfile,body.expectedRevision,
        tenant.hash,body.appProfile,cap.sessionBinding,tenant.hash,body.requestId);
  const results=await db.batch([change,
    db.prepare(`INSERT INTO _push_requests(token_hash,request_id,fingerprint,app_profile,revision)
      SELECT ?,?,?,?,revision FROM _push_registrations WHERE token_hash=? AND app_profile=? AND changes()>0`)
      .bind(tenant.hash,body.requestId,fingerprint,body.appProfile,tenant.hash,body.appProfile),
    db.prepare(`SELECT q.fingerprint,q.revision AS receipt_revision,r.* FROM _push_requests q
      JOIN _push_registrations r ON r.token_hash=q.token_hash AND r.app_profile=q.app_profile
      JOIN _tokens t ON t.hash=q.token_hash AND t.revoked_at IS NULL
      WHERE q.token_hash=? AND q.request_id=?`).bind(tenant.hash,body.requestId),
  ]);
  const row=results[2].results[0];
  if(row?.fingerprint!==fingerprint && row)return json({kind:'conflict',code:'request_reused'},409);
  if(!row || row.revision!==row.receipt_revision)return json({kind:'conflict',code:'registration_changed'},409);
  return json({kind:'confirmed',receipt:{requestId:body.requestId,registration:publicState(row,cap)}});
}

const base64url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export async function pushIdentity(deployment,eventId){
  return base64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['life-notification-v1',deployment,eventId]))));
}

let cachedProvider;
async function providerToken(config,pem,now){
  if(cachedProvider?.pem===pem && cachedProvider.team===config.teamId && cachedProvider.key===config.keyId
    && now>=cachedProvider.at && now-cachedProvider.at<3000000)return cachedProvider.token;
  const der=Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',der,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const encode=x=>base64url(new TextEncoder().encode(JSON.stringify(x)));
  const input=encode({alg:'ES256',kid:config.keyId})+'.'+encode({iss:config.teamId,iat:Math.floor(now/1000)});
  const token=input+'.'+base64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(input)));
  cachedProvider={pem,team:config.teamId,key:config.keyId,at:now,token};
  return token;
}

/** Bounded auth-store outbox drain. Remote acceptance never changes read state.
 * A short lease prevents concurrent flushes from submitting the same request;
 * ambiguous failures may retry with the same collapse identity. */
export async function deliverPush(env,send=fetch,now=Date.now()){
  const config=pushConfiguration(env);
  if(!config)return;
  const db=env.AUTH_DB;
  await ensurePush(db);
  const {results:registrations}=await db.prepare(`SELECT r.* FROM _push_registrations r
    JOIN _tokens t ON t.hash=r.token_hash AND t.revoked_at IS NULL
    JOIN _push_enrollments e ON e.token_hash=r.token_hash AND e.app_profile=r.app_profile
    WHERE r.state='active' AND r.lease_until<=?
      AND r.app_profile IN (${config.profiles.map(()=>'?').join(',')})
      AND EXISTS(SELECT 1 FROM _notifications n LEFT JOIN _push_deliveries d
        ON d.installation_id=r.installation_id AND d.event_id=n.id
        WHERE n.seq=(SELECT min(seq) FROM _notifications WHERE seq>r.delivery_cursor)
          AND coalesce(d.next_attempt,0)<=?)
      ORDER BY r.updated_at LIMIT 20`).bind(now,...config.profiles.map(p=>p.id),now).all();
  let jwt;
  let remaining=40;
  const deadline=Date.now()+20000;
  for(const registration of registrations){
    const profile=config.profiles.find(p=>p.id===registration.app_profile);
    if(!profile || remaining===0 || Date.now()>=deadline)continue;
    const lease=crypto.randomUUID();
    const claimed=await db.prepare(`UPDATE _push_registrations SET delivery_lease=?,lease_until=?
      WHERE installation_id=? AND revision=? AND state='active' AND lease_until<=?
      AND EXISTS(SELECT 1 FROM _tokens WHERE hash=token_hash AND revoked_at IS NULL) RETURNING *`)
      .bind(lease,now+60000,registration.installation_id,registration.revision,now).first();
    if(!claimed)continue;
    try{
      for(let count=0;count<4 && remaining>0 && Date.now()<deadline;count++){
      const event=await db.prepare(`SELECT n.*,coalesce(d.attempts,0) AS attempts,coalesce(d.next_attempt,0) AS next_attempt
        FROM _notifications n LEFT JOIN _push_deliveries d ON d.installation_id=? AND d.event_id=n.id
        WHERE n.seq>? ORDER BY n.seq LIMIT 1`).bind(claimed.installation_id,claimed.delivery_cursor).first();
      if(!event || event.next_attempt>now)break;
      remaining--;
      const body=JSON.stringify({aps:{alert:{title:event.title,body:event.body},sound:'default'},
        lifeNotification:{deploymentIdentity:config.deploymentIdentity,eventId:event.id}});
      let outcome='retry',invalidToken=false;
      if(new TextEncoder().encode(body).length>4096)outcome='permanent';
      else{
        let collapse;
        try{
          jwt??=await providerToken(config,env.APNS_PRIVATE_KEY,now);
          collapse=await pushIdentity(config.deploymentIdentity,event.id);
        }catch{console.warn('APNs signing failed');}
        // Recheck authorization and generation immediately before dispatch.
        const current=await db.prepare(`SELECT 1 FROM _push_registrations r JOIN _tokens t ON t.hash=r.token_hash
          WHERE r.installation_id=? AND r.revision=? AND r.delivery_lease=? AND r.state='active' AND t.revoked_at IS NULL`)
          .bind(claimed.installation_id,claimed.revision,lease).first();
        if(!current)break;
        try{
          if(!jwt || !collapse)throw Error('Provider token unavailable');
          const response=await send(`https://${profile.environment==='sandbox'?'api.sandbox.push.apple.com':'api.push.apple.com'}/3/device/${claimed.device_token}`,{
            method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
            headers:{authorization:`bearer ${jwt}`,'content-type':'application/json','apns-topic':profile.topic,
              'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(now/1000)+86400),
              'apns-collapse-id':collapse},body});
          if(response.status===200)outcome='accepted';
          else{
            const {reason}=await response.json().catch(()=>({}));
            const safeReason=['InvalidProviderToken','ExpiredProviderToken','MissingProviderToken',
              'Forbidden','BadEnvironmentKeyIdInToken','BadDeviceToken','DeviceTokenNotForTopic',
              'BadTopic','TopicDisallowed','Unregistered','TooManyRequests','TooManyProviderTokenUpdates',
              'InternalServerError','ServiceUnavailable','Shutdown'].includes(reason)?reason:'Other';
            console.warn('APNs delivery refused',response.status,safeReason);
            if(response.status===410 || response.status===400){
              invalidToken=response.status===410 || ['BadDeviceToken','DeviceTokenNotForTopic'].includes(reason);
              outcome='permanent';
            }
          }
        }catch(error){
          const safeError=['Network connection lost.','Illegal invocation','The operation was aborted',
            'The operation timed out','Cannot perform I/O on behalf of a different request',
            'Provider token unavailable','Parse Error: Expected HTTP/'].find(message=>
              typeof error?.message==='string' && error.message.includes(message))??'Other';
          console.warn('APNs transport failed',safeError);
        }
      }
      const attempts=event.attempts+1;
      const retryAt=outcome==='retry'?now+Math.min(3600000,30000*2**Math.min(attempts-1,7)):0;
      const guard=`EXISTS(SELECT 1 FROM _push_registrations r JOIN _tokens t ON t.hash=r.token_hash
        WHERE r.installation_id=? AND r.revision=? AND r.delivery_lease=? AND r.state='active' AND t.revoked_at IS NULL)`;
      await db.batch([
        db.prepare(`INSERT INTO _push_deliveries(installation_id,event_id,revision,outcome,attempts,next_attempt)
          SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(installation_id,event_id) DO UPDATE SET
          revision=excluded.revision,outcome=excluded.outcome,attempts=excluded.attempts,next_attempt=excluded.next_attempt`)
          .bind(claimed.installation_id,event.id,claimed.revision,outcome,attempts,retryAt,claimed.installation_id,claimed.revision,lease),
        db.prepare(`UPDATE _push_registrations SET delivery_cursor=CASE WHEN ?='retry' THEN delivery_cursor ELSE ? END,
          state=CASE WHEN ? THEN 'revoked' ELSE state END,device_token=CASE WHEN ? THEN NULL ELSE device_token END,
          revision=CASE WHEN ? THEN ? ELSE revision END
          WHERE installation_id=? AND revision=? AND delivery_lease=? AND state='active'
          AND EXISTS(SELECT 1 FROM _tokens WHERE hash=token_hash AND revoked_at IS NULL)`)
          .bind(outcome,event.seq,Number(invalidToken),Number(invalidToken),Number(invalidToken),crypto.randomUUID(),claimed.installation_id,claimed.revision,lease),
      ]);
      if(outcome==='retry' || invalidToken)break;
      claimed.delivery_cursor=event.seq;
      }
    }finally{
      await db.prepare('UPDATE _push_registrations SET delivery_lease=NULL,lease_until=0 WHERE installation_id=? AND delivery_lease=?')
        .bind(claimed.installation_id,lease).run();
    }
  }
}
