import {expect,test} from 'bun:test';
import worker from '../src/main.js';
import hub from '../src/index.js';
import {hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';

const target={table:'items',rowId:'r'};
const patch=changes=>({target,intent:{kind:'patch',changes:Object.entries(changes).map(([column,value])=>({column,after:typeof value==='string'?{type:'text',value}:value===null?{type:'null'}:{type:'integer',value:String(value)}}))}});
async function fixture(){
  const env={DB:new D1Shim(),AUTH_DB:new D1Shim(),HUB_TOKEN:'operator',LOGIN_ACCESS_AUD:'aud',
    GOVERNANCE_DEPLOYMENT_ID:'synthetic-deployment',GOVERNANCE_PREVIEW_KEY:Buffer.alloc(32,7).toString('base64url')};
  const ctx={access:{aud:'aud',getIdentity:async()=>({email:'user@example.test'})},waitUntil(){}};
  await hub.fetch(new Request('https://hub.test/login',{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({key:await hashToken('user'),name:'Synthetic device'})}),env,ctx);
  const mint=await hub.fetch(new Request('https://hub.test/v1/tokens/create',{method:'POST',headers:{Authorization:'Bearer operator'},body:JSON.stringify({name:'agent',scopes:'tables:read:items'})}),env,ctx);
  const agent=(await mint.json()).token;
  env.DB.db.exec(`CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
    CREATE TABLE items(id TEXT PRIMARY KEY,label TEXT,qty INTEGER,other TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO items VALUES ('r','first',1,'keep','2025-01-01T00:00:00.000Z',NULL,NULL);
    INSERT INTO catalog_tables VALUES ('items','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('label','items','label','text'),('qty','items','qty','int'),('other','items','other','text');`);
  const call=async(path,body={},token='user')=>{
    const pending=[];
    const response=await worker.fetch(new Request('https://hub.test/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);
    return {status:response.status,body:await response.json(),headers:response.headers,pending};
  };
  // Ordinary workspace initialization may create server storage. Preview cannot.
  await call('schema/pull');
  const row=()=>env.DB.db.query('SELECT * FROM items').get();
  const update=values=>call('rows/patch',{table:'items',id:'r',values,expected_revision:{updated_at:row().updated_at,hub_at:row().hub_at}});
  const snapshots=()=>[env.DB,env.AUTH_DB].map(db=>db.db.serialize());
  return {env,call,agent,row,update,snapshots};
}

test('actual wrapped preview validates without persistent effects and issues an opaque principal-bound token',async()=>{
  const {call,row,snapshots,agent}=await fixture();
  const before=snapshots();
  const r=await call('governance/preview',patch({label:'second',qty:2}),agent);
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');
  expect(r.body.value.changes).toEqual([{column:'label',before:{type:'text',value:'first'},after:{type:'text',value:'second'}},{column:'qty',before:{type:'integer',value:'1'},after:{type:'integer',value:'2'}}]);
  expect(r.body.value.previewToken).toBeString();expect(r.body.value.previewToken).not.toContain('second');
  expect(r.body.value.revision).toEqual({updated_at:row().updated_at,hub_at:null});
  expect(r.headers.get('Cache-Control')).toBe('no-store');
  expect(r.pending).toEqual([]);expect(snapshots()).toEqual(before);
});
test('preview refuses unsupported SQL/reference scope before returning cell values',async()=>{
  const {call,env,agent}=await fixture();
  env.DB.db.exec("CREATE TABLE hidden(id TEXT PRIMARY KEY,updated_at TEXT); INSERT INTO catalog_tables VALUES ('hidden','table',NULL); UPDATE catalog_properties SET type='ref',ref_table='hidden' WHERE id='label'");
  const r=await call('governance/preview',patch({label:'secret'}),agent);
  expect(r.status).toBe(200);expect(r.body).toEqual({kind:'unavailable'});
});
test('valid planning conflicts return a tokenless preview and no domain effects',async()=>{
  const {call,snapshots}=await fixture();
  const before=snapshots();
  const r=await call('governance/preview',patch({qty:'invalid'}));
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');
  expect(r.body.value.conflicts[0].code).toBe('validation_failed');
  expect(r.body.value.previewToken).toBeNull();expect(r.body.value.expiresAt).toBeNull();
  expect(snapshots()).toEqual(before);
});
test('selected inverse reads canonical typed evidence and retains unrelated later edits',async()=>{
  const {call,update,env}=await fixture();
  await update({label:'second'});
  const id=env.DB.db.query("SELECT id FROM history WHERE col='label'").get().id;
  await update({other:'later'});
  const r=await call('governance/preview',{target,intent:{kind:'selected_inverse',eventIds:[id]}});
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');
  expect(r.body.value.changes).toEqual([{column:'label',before:{type:'text',value:'second'},after:{type:'text',value:'first'}}]);
  expect(r.body.value.selectedEventIds).toEqual([id]);expect(r.body.value.previewToken).toBeString();
});
test('removed selected canonical event is unavailable even with its private metadata',async()=>{
  const {call,update,env}=await fixture();await update({label:'second'});
  const id=env.DB.db.query("SELECT id FROM history WHERE col='label'").get().id;
  env.DB.db.query('DELETE FROM history WHERE id=?').run(id);
  const r=await call('governance/preview',{target,intent:{kind:'selected_inverse',eventIds:[id]}});
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');
  expect(r.body.value.conflicts[0].code).toBe('history_unavailable');expect(r.body.value.previewToken).toBeNull();
});
async function propose(f,values={label:'second'},token=f.agent){
  const p=await f.call('governance/preview',patch(values),token);
  expect(p.body.kind).toBe('success');
  const request={previewToken:p.body.value.previewToken,idempotencyKey:crypto.randomUUID(),claimedOrigin:'unverified-origin'};
  const r=await f.call('governance/proposals/create',request,token);
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');
  return {proposal:r.body.value,request};
}
async function approval(f,proposal){
  const p=await f.call('governance/proposals/preview',{proposalId:proposal.id,expectedVersion:proposal.version});
  expect(p.status).toBe(200);expect(p.body.kind).toBe('success');expect(p.body.value.previewToken).toBeString();
  return {proposalId:proposal.id,expectedVersion:proposal.version,previewToken:p.body.value.previewToken,idempotencyKey:crypto.randomUUID()};
}
test('agent proposes, verified user previews and atomically approves with linked canonical history and receipt',async()=>{
  const f=await fixture(),{proposal,request}=await propose(f,{label:'second',qty:2});
  expect(f.row().label).toBe('first');expect(proposal.proposedBy.kind).toBe('agent');expect(proposal.claimedOrigin).toBe('unverified-origin');
  expect((await f.call('governance/proposals/create',request,f.agent)).body.value).toEqual(proposal);
  const a=await approval(f,proposal);
  const denied=await f.call('governance/proposals/approve',a,f.agent);
  expect(denied.status).toBe(403);expect(denied.body.resolution).toBe('unresolved');
  const r=await f.call('governance/proposals/approve',a);
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');
  expect(f.row()).toMatchObject({label:'second',qty:2,other:'keep'});
  expect(r.body.value).toMatchObject({proposalId:proposal.id,proposalVersion:proposal.version,target,approvedBy:{kind:'user'}});
  expect(r.body.value.historyEventIds.length).toBe(2);
  const events=f.env.DB.db.query('SELECT event_id,operation_id,actor_json FROM _governance_history ORDER BY seq').all();
  expect(events.map(e=>e.event_id)).toEqual(r.body.value.historyEventIds);
  expect(events.every(e=>e.operation_id===r.body.value.operationId && JSON.parse(e.actor_json).principalId===r.body.value.approvedBy.principalId)).toBe(true);
  await f.update({other:'newer'});
  const replay=await f.call('governance/proposals/approve',a);
  expect(replay.body).toEqual(r.body);expect(f.row().other).toBe('newer');
  const read=await f.call('governance/proposals/get',{proposalId:proposal.id});
  expect(read.body.value.state).toBe('approved');
});
test('editing creates an immutable new version; stale approval and terminal changes settle negatively',async()=>{
  const f=await fixture(),{proposal}=await propose(f);
  const stale=await approval(f,proposal);
  const preview=await f.call('governance/preview',patch({label:'edited'}),f.agent);
  const edit=await f.call('governance/proposals/edit',{proposalId:proposal.id,expectedVersion:proposal.version,previewToken:preview.body.value.previewToken,idempotencyKey:'edit'},f.agent);
  expect(edit.status).toBe(200);expect(edit.body.kind).toBe('success');expect(edit.body.value.version).not.toBe(proposal.version);
  expect((await f.call('governance/proposals/get',{proposalId:proposal.id,version:proposal.version})).body.value).toEqual(proposal);
  const r=await f.call('governance/proposals/approve',stale);
  expect(r.status).toBe(409);expect(r.body).toMatchObject({kind:'error',code:'proposal_changed',resolution:'not_committed'});
  expect((await f.call('governance/proposals/approve',stale)).body).toEqual(r.body);
  const rejection={proposalId:proposal.id,expectedVersion:edit.body.value.version,idempotencyKey:'reject'};
  const rejected=await f.call('governance/proposals/reject',rejection);
  expect(rejected.body.value.state).toBe('rejected');
  expect((await f.call('governance/proposals/reject',rejection)).body).toEqual(rejected.body);
  expect((await f.call('governance/proposals/preview',{proposalId:proposal.id,expectedVersion:edit.body.value.version})).body).toEqual({kind:'unavailable'});
  expect(f.row().label).toBe('first');
});
test('row and catalog dependency edits invalidate approval; exact negative key cannot later apply',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approval(f,proposal);
  await f.update({other:'later'});
  const r=await f.call('governance/proposals/approve',a);
  expect(r.status).toBe(409);expect(r.body).toMatchObject({kind:'error',code:'revision_changed',resolution:'not_committed'});
  expect(f.row().label).toBe('first');
  expect((await f.call('governance/proposals/approve',a)).body).toEqual(r.body);
  const changed=await f.call('governance/proposals/approve',{...a,expectedVersion:'different'});
  expect(changed.status).toBe(409);expect(changed.body).toEqual({kind:'error',code:'idempotency_conflict',resolution:'unresolved',conflicts:[]});
});
test('history and proposal reads are bounded and preserve unknown legacy types',async()=>{
  const f=await fixture(),{proposal}=await propose(f);await f.update({label:'local'});
  f.env.DB.db.exec("INSERT INTO history (id,tbl,row_id,col,old,new,origin,created_at,updated_at) VALUES ('legacy','items','r','qty','0','1','claimed','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')");
  const history=await f.call('governance/history/events',{target,limit:1});
  expect(history.status).toBe(200);expect(history.body.value.events.length).toBe(1);expect(history.body.value.nextCursor).toBeString();
  const next=await f.call('governance/history/events',{target,limit:1,cursor:history.body.value.nextCursor});
  const legacy=[...history.body.value.events,...next.body.value.events].find(e=>e.id==='legacy');
  expect(legacy).toMatchObject({before:null,after:null,actor:null,reversible:false});
  const list=await f.call('governance/proposals/list',{target,state:'pending',limit:1});
  expect(list.body.value.proposals).toEqual([proposal]);
});
function holdApproval(db){
  const prepare=db.prepare.bind(db),batch=db.batch.bind(db);
  db.prepare=sql=>Object.assign(prepare(sql),{testSql:sql});
  let release,arrived;
  const paused=new Promise(resolve=>{arrived=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  let held=false;
  db.batch=async statements=>{
    if(!held && statements.some(s=>s.testSql?.includes("SET state='approved'"))){held=true;arrived();await resume;}
    return batch(statements);
  };
  return {paused,release};
}
test('HTTP negative receipt wins against a delayed original approval and permanently excludes its write',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approval(f,proposal);
  const held=holdApproval(f.env.DB),original=f.call('governance/proposals/approve',a);
  await held.paused;
  await f.update({other:'newer'});
  const negative=await f.call('governance/proposals/approve',a);
  expect(negative.body).toMatchObject({kind:'error',code:'revision_changed',resolution:'not_committed'});
  held.release();expect((await original).body).toEqual(negative.body);
  expect(f.row()).toMatchObject({label:'first',other:'newer'});
  expect(f.env.DB.db.query("SELECT state FROM _governance_proposals WHERE id=?").get(proposal.id).state).toBe('pending');
  expect(f.env.DB.db.query("SELECT count(*) AS n FROM _governance_history WHERE operation_id IS NOT NULL").get().n).toBe(0);
});
test('a concurrent proposal rejection rolls back every approval field, history event and receipt',async()=>{
  const f=await fixture(),{proposal}=await propose(f,{label:'second',qty:2}),a=await approval(f,proposal);
  const held=holdApproval(f.env.DB),original=f.call('governance/proposals/approve',a);
  await held.paused;
  const rejected=await f.call('governance/proposals/reject',{proposalId:proposal.id,expectedVersion:proposal.version,idempotencyKey:'reject-race'});
  expect(rejected.body.value.state).toBe('rejected');
  held.release();const r=await original;
  expect(r.body).toMatchObject({kind:'error',resolution:'not_committed'});
  expect(f.row()).toMatchObject({label:'first',qty:1});
  expect(f.env.DB.db.query("SELECT count(*) AS n FROM _governance_history").get().n).toBe(0);
});
test('completed approval replays before newer catalog/history validation but current read/write grants still govern disclosure',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approval(f,proposal);
  const done=await f.call('governance/proposals/approve',a);expect(done.body.kind).toBe('success');
  f.env.DB.db.exec("UPDATE catalog_properties SET required=1; DELETE FROM history;");
  expect((await f.call('governance/proposals/approve',a)).body).toEqual(done.body);
  f.env.AUTH_DB.db.query("UPDATE _tokens SET scopes='tables:read:items' WHERE hash=?").run(await hashToken('user'));
  const denied=await f.call('governance/proposals/approve',a);
  expect(denied.status).toBe(404);expect(denied.body).toEqual({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]});
  f.env.AUTH_DB.db.query("UPDATE _tokens SET revoked_at='revoked' WHERE hash=?").run(await hashToken('user'));
  expect((await f.call('governance/proposals/approve',a)).body).toEqual({kind:'error',code:'permission_denied',resolution:'unresolved',conflicts:[]});
});
test('column purge redacts every version and associated receipt; old tokens and late requests cannot revive it',async()=>{
  const f=await fixture(),{proposal,request}=await propose(f,{label:'sensitive-old'});
  const p=await f.call('governance/preview',patch({other:'different'}),f.agent);
  const editRequest={proposalId:proposal.id,expectedVersion:proposal.version,previewToken:p.body.value.previewToken,idempotencyKey:'edit-purge'};
  const edit=await f.call('governance/proposals/edit',editRequest,f.agent);
  const a=await approval(f,edit.body.value),done=await f.call('governance/proposals/approve',a);
  expect(done.body.kind).toBe('success');
  const {applyPurges}=await import('../src/purge.js');
  await applyPurges(f.env.DB,[{tbl:'items',row_id:'r',col:'label',purged_at:'2099-01-01T00:00:00.000Z'}]);
  expect(f.env.DB.db.query('SELECT * FROM _governance_versions').all()).toEqual([]);
  for(const [path,args,token] of [['create',request,f.agent],['edit',editRequest,f.agent],['approve',a,'user']]){
    expect((await f.call('governance/proposals/'+path,args,token)).body).toEqual({kind:'purged'});
  }
  expect((await f.call('governance/proposals/get',{proposalId:proposal.id})).body).toEqual({kind:'unavailable'});
});
test('a retained inverse proposal cannot apply after its selected canonical event is removed',async()=>{
  const f=await fixture();await f.update({label:'second'});
  const id=f.env.DB.db.query("SELECT id FROM history WHERE col='label'").get().id;
  const p=await f.call('governance/preview',{target,intent:{kind:'selected_inverse',eventIds:[id]}},f.agent);
  const c=await f.call('governance/proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'inverse'},f.agent);
  expect(c.body.kind).toBe('success');const a=await approval(f,c.body.value);
  f.env.DB.db.query('DELETE FROM history WHERE id=?').run(id);
  const r=await f.call('governance/proposals/approve',a);
  expect(r.status).toBe(422);expect(r.body).toMatchObject({kind:'error',code:'history_unavailable',resolution:'not_committed'});
  expect(f.row().label).toBe('second');
});
test('configuration, malformed arguments, field limits and unsupported methods never activate another writer',async()=>{
  const f=await fixture();
  for(const [body,status] of [[{...patch({label:'x'}),actor:{kind:'user'}},400],[{target:{table:['items'],rowId:'r'},intent:patch({label:'x'}).intent},400],[patch({label:'x'.repeat(65536)}),413]]){
    const r=await f.call('governance/preview',body);expect(r.status).toBe(status);expect(r.body).toEqual({kind:'unavailable'});
  }
  delete f.env.GOVERNANCE_PREVIEW_KEY;
  expect((await f.call('governance/preview',patch({label:'x'}))).status).toBe(503);
  expect(f.row().label).toBe('first');
});
test('old preview material cannot create another proposal after purge invalidation',async()=>{
  const f=await fixture();
  const p=await f.call('governance/preview',patch({label:'sensitive'}),f.agent);
  const {applyPurges}=await import('../src/purge.js');
  await applyPurges(f.env.DB,[{tbl:'items',row_id:'r',col:'label',purged_at:'2099-01-01T00:00:00.000Z'}]);
  const r=await f.call('governance/proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'after-purge'},f.agent);
  expect(r.body).toMatchObject({kind:'error',code:'revision_changed',resolution:'not_committed'});
  expect(f.env.DB.db.query('SELECT * FROM _governance_versions').all()).toEqual([]);
});
test('expired uncommitted previews settle negatively; committed retries survive preview expiry and signing-key rotation',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approval(f,proposal);
  const done=await f.call('governance/proposals/approve',a);expect(done.body.kind).toBe('success');
  const p=await f.call('governance/preview',patch({label:'third'}),f.agent);
  const original=Date.now;Date.now=()=>original()+301000;
  try{
    const expired=await f.call('governance/proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'expired'},f.agent);
    expect(expired.status).toBe(409);expect(expired.body).toMatchObject({kind:'error',code:'expired_preview',resolution:'not_committed'});
    f.env.GOVERNANCE_PREVIEW_KEY=Buffer.alloc(32,9).toString('base64url');
    expect((await f.call('governance/proposals/approve',a)).body).toEqual(done.body);
  }finally{Date.now=original;}
});
test('lost committed reply followed by usage cap remains unresolved and later recovers the same receipt',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approval(f,proposal);
  const done=await f.call('governance/proposals/approve',a);expect(done.body.kind).toBe('success');
  f.env.AUTH_DB.db.exec('UPDATE _usage SET rows_read=100');
  f.env.USAGE_LIMITS=JSON.stringify({d1_rows_read:{cap:1}});
  const original=Date.now;Date.now=()=>original()+31000;
  try{
    const capped=await f.call('governance/proposals/approve',a);
    expect(capped.status).toBe(429);expect(capped.body).toEqual({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]});
    expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);
    delete f.env.USAGE_LIMITS;
    expect((await f.call('governance/proposals/approve',a)).body).toEqual(done.body);
  }finally{Date.now=original;}
});
test('another principal cannot use or inspect an issued preview, and inaccessible proposal pages disclose no cursor',async()=>{
  const f=await fixture(),p=await f.call('governance/preview',patch({label:'x'}),f.agent);
  const denied=await f.call('governance/proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'wrong-principal'});
  expect(denied.body.kind).toBe('error');expect(denied.body.resolution).toBe('unresolved');
  await propose(f);await propose(f,{label:'third'});
  f.env.AUTH_DB.db.query("UPDATE _tokens SET scopes='tables:read:missing' WHERE hash=?").run(await hashToken(f.agent));
  expect((await f.call('governance/proposals/list',{limit:1},f.agent)).body).toEqual({kind:'success',value:{proposals:[],nextCursor:null}});
});
test('changed reference row and catalog invalidate exact preview dependencies',async()=>{
  const f=await fixture();
  f.env.DB.db.exec("CREATE TABLE refs(id TEXT PRIMARY KEY,updated_at TEXT,deleted_at TEXT); INSERT INTO refs VALUES ('first','2025',NULL); INSERT INTO catalog_tables VALUES ('refs','table',NULL); UPDATE catalog_properties SET type='ref',ref_table='refs' WHERE id='label'");
  const p=await f.call('governance/preview',patch({qty:2}));expect(p.body.value.previewToken).toBeString();
  f.env.DB.db.exec("UPDATE refs SET updated_at='newer'");
  const r=await f.call('governance/proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'changed-dep'});
  expect(r.body).toMatchObject({kind:'error',code:'revision_changed',resolution:'not_committed'});
  expect(f.row().qty).toBe(1);
});
test('negative expiry settlement excludes a previously validated delayed original even when all row guards still match',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approval(f,proposal);
  const held=holdApproval(f.env.DB),original=f.call('governance/proposals/approve',a);
  await held.paused;
  const now=Date.now;Date.now=()=>now()+301000;
  let negative;
  try{negative=await f.call('governance/proposals/approve',a);}finally{Date.now=now;}
  expect(negative.body).toMatchObject({kind:'error',code:'expired_preview',resolution:'not_committed'});
  held.release();expect((await original).body).toEqual(negative.body);
  expect(f.row().label).toBe('first');
  expect(f.env.DB.db.query('SELECT count(*) AS n FROM _governance_history').get().n).toBe(0);
});
test('read-only proposal preview preserves both stores and schedules no work',async()=>{
  const f=await fixture(),{proposal}=await propose(f);
  const before=f.snapshots();
  const r=await f.call('governance/proposals/preview',{proposalId:proposal.id,expectedVersion:proposal.version});
  expect(r.body.value.previewToken).toBeString();expect(r.pending).toEqual([]);expect(f.snapshots()).toEqual(before);
});
test('denied proposal resource uses the same unavailable envelope as an absent resource',async()=>{
  const f=await fixture(),{proposal}=await propose(f);
  f.env.AUTH_DB.db.query("UPDATE _tokens SET scopes='tables:read:missing' WHERE hash=?").run(await hashToken(f.agent));
  for(const id of [proposal.id,'missing']){
    const r=await f.call('governance/proposals/reject',{proposalId:id,expectedVersion:proposal.version,idempotencyKey:'denied-'+id},f.agent);
    expect(r.status).toBe(404);expect(r.body).toEqual({kind:'error',code:'unavailable',resolution:'unresolved',conflicts:[]});
  }
});
test('huge current cells never produce a preview token too large for its own mutation request',async()=>{
  const f=await fixture();f.env.DB.db.query('UPDATE items SET label=?').run('x'.repeat(50000));
  const r=await f.call('governance/preview',patch({label:'short'}));
  expect(r.status).toBe(200);expect(r.body.value.previewToken).toBeNull();expect(r.body.value.conflicts[0].code).toBe('unavailable');
});
