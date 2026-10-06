import {expect,test} from 'bun:test';
import worker from '../src/index.js';
import {hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';

const scopes=['tables:read:contacts:id','tables:read:contacts:name'];
const profiles={'contact-reader-v1':{label:'Contact Reader',scopes}};
const context={access:{aud:'fixture',getIdentity:async()=>({email:'owner@example.test'})},waitUntil(){}};
const env=()=>({HUB_TOKEN:'root',AUTH_DB:new D1Shim(),DB:{prepare(){throw Error('unexpected data access');}},LOGIN_ACCESS_AUD:'fixture',ENROLLMENT_PROFILES:JSON.stringify(profiles)});
const call=(e,path,method='GET',body,token)=>worker.fetch(new Request('https://hub.test'+path,{method,headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded',...(token?{Authorization:'Bearer '+token}:{})},body}),e,context);
async function approval(e,token='candidate',profile='contact-reader-v1'){
 const key=await hashToken(token);
 const r=await call(e,`/login?key=${key}&name=Phone&profile=${profile}`);
 const html=await r.text();
 expect(r.status).toBe(200);
 expect(html).toContain('Contact Reader');
 expect(html).toContain('tables:read:contacts:name');
 const revision=html.match(/name="profileRevision" value="([0-9a-f]{64})"/)?.[1];
 expect(revision).toHaveLength(64);
 return new URLSearchParams({key,name:'Phone',profile,profileRevision:revision}).toString();
}

test('profile approval binds exact grants and receipt without governance authority or data access',async()=>{
 const e=env(),form=await approval(e);
 expect(e.AUTH_DB.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
 expect((await call(e,'/login','POST',form)).status).toBe(200);
 const r=await call(e,'/v1/session','GET',undefined,'candidate'),data=await r.json();
 expect(r.status).toBe(200);expect(data.scopes).toEqual(scopes);
 expect(data.enrollmentProfile).toEqual({id:'contact-reader-v1',revision:new URLSearchParams(form).get('profileRevision')});
 expect(data.capabilities.replica_sync).toBe(false);expect(data.capabilities.governance).toBeUndefined();
 expect(e.AUTH_DB.db.query('SELECT * FROM _governance_authorities').all()).toEqual([]);
 expect((await call(e,'/login','POST',form)).status).toBe(200);
 expect((await call(e,'/v1/session','POST',undefined,'candidate')).status).toBe(200);
 expect((await call(e,'/v1/session','GET',undefined,'candidate')).status).toBe(401);
 expect((await call(e,'/login','POST',form)).status).toBe(409);
});

test('profile failures never fall back to full or write auth state',async()=>{
 for(const config of [undefined,'invalid','{}',JSON.stringify({'contact-reader-v1':{label:'Contact Reader',scopes:['full']}}),JSON.stringify({'contact-reader-v1':{label:'Contact Reader',scopes:['tables:read:contacts:name']}})]){
  const e=env();e.ENROLLMENT_PROFILES=config;
  const key=await hashToken('candidate');
  const get=await call(e,`/login?key=${key}&name=Phone&profile=contact-reader-v1`);
  expect(get.status).not.toBe(200);
  const post=await call(e,'/login','POST',new URLSearchParams({key,name:'Phone',profile:'contact-reader-v1',profileRevision:'a'.repeat(64)}).toString());
  expect(post.status).not.toBe(200);
  expect(e.AUTH_DB.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
 }
});

test('approval rejects policy changes after display and requires revision',async()=>{
 const e=env(),form=await approval(e);
 e.ENROLLMENT_PROFILES=JSON.stringify({'contact-reader-v1':{label:'Contact Reader',scopes:[...scopes,'tables:read:contacts:private']}});
 expect((await call(e,'/login','POST',form)).status).toBe(409);
 const p=new URLSearchParams(form);p.delete('profileRevision');
 expect((await call(e,'/login','POST',p.toString())).status).toBe(400);
 expect(e.AUTH_DB.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
});

for(const first of ['profile','legacy'])test(`same fingerprint cannot cross profile/legacy boundary (${first} first)`,async()=>{
 const e=env(),form=await approval(e),p=new URLSearchParams(form);
 const legacy=new URLSearchParams({key:p.get('key'),name:'Phone'}).toString();
 const forms=first==='profile'?[form,legacy]:[legacy,form];
 expect((await call(e,'/login','POST',forms[0])).status).toBe(200);
 expect((await call(e,'/login','POST',forms[1])).status).toBe(409);
 const session=await (await call(e,'/v1/session','GET',undefined,'candidate')).json();
 expect(session.scopes).toEqual(first==='profile'?scopes:['full']);
 expect(e.AUTH_DB.db.query('SELECT count(*) AS n FROM _governance_authorities').get().n).toBe(first==='profile'?0:1);
});

test('registration binding is checked inside the committing batch against a competing approval',async()=>{
 const e=env(),form=await approval(e),p=new URLSearchParams(form),original=e.AUTH_DB.batch.bind(e.AUTH_DB);
 e.AUTH_DB.batch=async stmts=>{
  e.AUTH_DB.batch=original;
  expect((await call(e,'/login','POST',new URLSearchParams({key:p.get('key'),name:'Other'}).toString())).status).toBe(200);
  return original(stmts);
 };
 expect((await call(e,'/login','POST',form)).status).toBe(409);
 const session=await (await call(e,'/v1/session','GET',undefined,'candidate')).json();
 expect(session.scopes).toEqual(['full']);expect(session.enrollmentProfile).toBeUndefined();
});

test('rejected legacy approval cannot promote an existing non-device credential',async()=>{
 const e=env(),key=await hashToken('candidate');
 const {ensureAuthReady}=await import('../src/auth.js');await ensureAuthReady(e.AUTH_DB);
 e.AUTH_DB.db.query("INSERT INTO _tokens(hash,name,scopes) VALUES (?,'service-reader','full')").run(key);
 const before=e.AUTH_DB.db.query('SELECT * FROM _tokens').all();
 const form=new URLSearchParams({key,name:'Phone'}).toString();
 expect((await call(e,'/login','POST',form)).status).toBe(409);
 expect(e.AUTH_DB.db.query('SELECT * FROM _tokens').all()).toEqual(before);
 expect(e.AUTH_DB.db.query('SELECT * FROM _governance_authorities').all()).toEqual([]);
});
