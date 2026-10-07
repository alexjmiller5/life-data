import {expect,test} from 'bun:test';
import worker from '../src/main.js';
import hub from '../src/index.js';
import {hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';
const prefix='governance/changesets/';
const old='2020-01-01T00:00:00.000Z';
const revision={updated_at:old,hub_at:null};
const input={operations:[
  {kind:'create',table:'entries',id:'e',expected_revision:null,values:{bucket:'b',qty:2}},
  {kind:'patch',table:'buckets',id:'b',expected_revision:revision,values:{label:null}},
],reads:[{table:'buckets',where:{id:'b'},expected:[{id:'b',revision}]},{table:'entries',where:{bucket:'b',deleted_at:null},expected:[]}]};
async function fixture(){
  const env={DB:new D1Shim(),AUTH_DB:new D1Shim(),HUB_TOKEN:'operator',LOGIN_ACCESS_AUD:'aud',
    GOVERNANCE_DEPLOYMENT_ID:'synthetic-deployment',GOVERNANCE_PREVIEW_KEY:Buffer.alloc(32,7).toString('base64url')};
  const ctx={access:{aud:'aud',getIdentity:async()=>({email:'user@example.test'})},waitUntil(){}};
  await hub.fetch(new Request('https://hub.test/login',{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({key:await hashToken('user'),name:'Synthetic device'})}),env,ctx);
  const mint=await hub.fetch(new Request('https://hub.test/v1/tokens/create',{method:'POST',headers:{Authorization:'Bearer operator'},body:JSON.stringify({name:'agent',scopes:'tables:read'})}),env,ctx);
  const agent=(await mint.json()).token;
  env.DB.db.exec(`CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
    CREATE TABLE buckets(id TEXT PRIMARY KEY,label TEXT,note TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE entries(id TEXT PRIMARY KEY,bucket TEXT,qty INTEGER,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO buckets VALUES('b','whole','keep','${old}',NULL,NULL);
    INSERT INTO catalog_tables VALUES('buckets','table',NULL),('entries','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type,ref_table) VALUES('label','buckets','label','text',NULL),('bucket','entries','bucket','ref','buckets'),('qty','entries','qty','int',NULL);
    INSERT INTO catalog_rules VALUES('entry-xor','entries','invariant',1,'table',
      'SELECT c.id FROM changed c JOIN buckets b ON b.id=c.bucket WHERE c.deleted_at IS NULL AND b.label IS NOT NULL',NULL);
    INSERT INTO catalog_rules VALUES('bucket-xor','buckets','invariant',1,'table',
      'SELECT c.id FROM changed c WHERE c.deleted_at IS NULL AND c.label IS NOT NULL AND EXISTS(SELECT 1 FROM entries e WHERE e.bucket=c.id AND e.deleted_at IS NULL)',NULL);`);
  const call=async(path,body={},token='user')=>{
    const pending=[];const r=await worker.fetch(new Request('https://hub.test/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);return {status:r.status,body:await r.json(),pending};
  };
  await call('schema/pull');
  const snapshot=()=>[env.DB,env.AUTH_DB].map(db=>db.db.serialize());
  return {env,call,agent,snapshot};
}
async function propose(f){
  const preview=await f.call(prefix+'preview',input,f.agent);
  expect(preview.status).toBe(200);expect(preview.body.kind).toBe('success');
  const request={previewToken:preview.body.value.previewToken,idempotencyKey:'create-1'};
  const proposal=await f.call(prefix+'proposals/create',request,f.agent);
  expect(proposal.status).toBe(200);return {proposal:proposal.body.value,request};
}
async function approveRequest(f,proposal){
  const p=await f.call(prefix+'proposals/preview',{proposalId:proposal.id,expectedVersion:proposal.version});
  expect(p.body.kind).toBe('success');expect(p.body.value.previewToken).toBeString();
  return {proposalId:proposal.id,expectedVersion:proposal.version,previewToken:p.body.value.previewToken,idempotencyKey:'approve-1'};
}

test('actual HTTP changeset preview is inert across data, authorization and outbound effects',async()=>{
  const f=await fixture(),before=f.snapshot();
  const r=await f.call(prefix+'preview',input,f.agent);
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');expect(r.body.value.previewToken).toBeString();
  expect(r.body.value.changes.length).toBe(2);expect(r.pending).toEqual([]);expect(f.snapshot()).toEqual(before);
});

test('agent proposes and a verified user approves the whole cross-table result with one original-key receipt',async()=>{
  const f=await fixture(),{proposal,request}=await propose(f),a=await approveRequest(f,proposal);
  expect((await f.call(prefix+'proposals/create',request,f.agent)).body.value).toEqual(proposal);
  expect((await f.call(prefix+'proposals/approve',a,f.agent)).status).toBe(403);
  expect((await f.call(prefix+'proposals/approve',a,'operator')).status).toBe(403);
  const r=await f.call(prefix+'proposals/approve',a);
  expect(r.status).toBe(200);expect(r.body.kind).toBe('success');expect(r.body.value.rows.length).toBe(2);
  expect(r.body.value.approvedBy.kind).toBe('user');
  expect(f.env.DB.db.query('SELECT label,note FROM buckets').get()).toEqual({label:null,note:'keep'});
  expect(f.env.DB.db.query('SELECT id,bucket,qty FROM entries').all()).toEqual([{id:'e',bucket:'b',qty:2}]);
  expect(f.env.DB.db.query('SELECT operation_id FROM _governance_history').get().operation_id).toBe(r.body.value.operationId);
  f.env.DB.db.exec("UPDATE buckets SET note='later'");
  expect((await f.call(prefix+'proposals/approve',a)).body).toEqual(r.body);
  expect(f.env.DB.db.query('SELECT note FROM buckets').get().note).toBe('later');
});

test('a new sibling after preview invalidates approval with a durable negative receipt',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal);
  f.env.DB.db.exec(`INSERT INTO entries VALUES('concurrent','b',1,'${old}',NULL,NULL)`);
  const r=await f.call(prefix+'proposals/approve',a);
  expect(r.status).toBe(409);expect(r.body.resolution).toBe('not_committed');
  f.env.DB.db.exec("DELETE FROM entries WHERE id='concurrent'");
  expect((await f.call(prefix+'proposals/approve',a)).body).toEqual(r.body);
  expect(f.env.DB.db.query('SELECT label FROM buckets').get().label).toBe('whole');
  expect(f.env.DB.db.query('SELECT * FROM entries').all()).toEqual([]);
});

test('a terminal rejected receipt excludes a delayed original approval',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal),db=f.env.DB;
  const prepare=db.prepare.bind(db),batch=db.batch.bind(db);
  db.prepare=sql=>Object.assign(prepare(sql),{testSql:sql});
  let release,arrive,held=false;
  const reached=new Promise(r=>{arrive=r;}),resume=new Promise(r=>{release=r;});
  db.batch=async statements=>{if(!held && statements.some(s=>s.testSql?.includes("SET state='approved'"))){held=true;arrive();await resume;}return batch(statements);};
  const original=f.call(prefix+'proposals/approve',a);await reached;
  db.db.exec("UPDATE buckets SET note='concurrent'");
  const rejected=await f.call(prefix+'proposals/approve',a);
  expect(rejected.body.resolution).toBe('not_committed');
  release();expect((await original).body).toEqual(rejected.body);
  expect(db.db.query('SELECT label,note FROM buckets').get()).toEqual({label:'whole',note:'concurrent'});
  expect(db.db.query('SELECT * FROM entries').all()).toEqual([]);
});

test('receipt insertion failure rolls back all domain, proposal and canonical history changes',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal),db=f.env.DB;
  // Private schema tampering is refused before domain changes.
  db.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON _governance_changeset_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const r=await f.call(prefix+'proposals/approve',a);
  expect(r.body.kind).not.toBe('success');
  expect(db.db.query('SELECT label FROM buckets').get().label).toBe('whole');
  expect(db.db.query('SELECT * FROM entries').all()).toEqual([]);
  expect(db.db.query('SELECT state FROM _governance_changesets').get().state).toBe('pending');
});

test('same idempotency key with a changed body conflicts without returning the old receipt',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal);
  expect((await f.call(prefix+'proposals/approve',a)).body.kind).toBe('success');
  const r=await f.call(prefix+'proposals/approve',{...a,expectedVersion:'changed'});
  expect(r.status).toBe(409);expect(r.body).toMatchObject({code:'idempotency_conflict',resolution:'unresolved'});
});

test('revocation and reduced current scope deny replay of a committed result',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal);
  expect((await f.call(prefix+'proposals/approve',a)).body.kind).toBe('success');
  f.env.AUTH_DB.db.query("UPDATE _tokens SET scopes='tables:read' WHERE hash=?").run(await hashToken('user'));
  expect((await f.call(prefix+'proposals/approve',a)).status).toBe(403);
  f.env.AUTH_DB.db.query("UPDATE _tokens SET revoked_at='revoked' WHERE hash=?").run(await hashToken('user'));
  expect((await f.call(prefix+'proposals/approve',a)).status).toBe(401);
});

test('purging a member redacts proposals and original-key receipts and never allows reapplication',async()=>{
  const {applyPurges}=await import('../src/purge.js');
  const f=await fixture(),{proposal,request}=await propose(f),a=await approveRequest(f,proposal);
  const original=await f.call(prefix+'proposals/approve',a);expect(original.body.kind).toBe('success');
  await applyPurges(f.env.DB,[{tbl:'entries',row_id:'e',col:null,purged_at:'2099-01-01T00:00:00.000Z'}]);
  expect((await f.call(prefix+'proposals/get',{proposalId:proposal.id})).body).toEqual({kind:'unavailable'});
  expect((await f.call(prefix+'proposals/create',request,f.agent)).body).toEqual({kind:'purged'});
  expect((await f.call(prefix+'proposals/approve',a)).body).toEqual({kind:'purged'});
  expect(f.env.DB.db.query('SELECT payload FROM _governance_changesets').get().payload).toBeNull();
});

test('preview tokens are bound to the current principal and cannot be promoted to a different operation',async()=>{
  const f=await fixture();const p=await f.call(prefix+'preview',input,f.agent);
  const r=await f.call(prefix+'proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'wrong-principal'});
  expect(r.status).toBe(400);expect(f.env.DB.db.query('SELECT * FROM _governance_changesets').all()).toEqual([]);
});

test('an unversioned sibling edit cannot be hidden by restoring its displayed revision',async()=>{
  const f=await fixture();
  // Add an unrelated existing member before preview. It is part of the complete
  // table set, even when a malformed external writer keeps its row timestamps.
  f.env.DB.db.exec(`INSERT INTO entries VALUES('existing','other',1,'${old}',NULL,NULL)`);
  const {proposal}=await propose(f),a=await approveRequest(f,proposal);
  f.env.DB.db.exec("UPDATE entries SET qty=9 WHERE id='existing'");
  const r=await f.call(prefix+'proposals/approve',a);
  expect(r.status).toBe(409);expect(r.body.resolution).toBe('not_committed');
  expect(f.env.DB.db.query('SELECT label FROM buckets').get().label).toBe('whole');
});

test('insert-only evidence joins the approval and an existing edge can never be overwritten',async()=>{
  const f=await fixture(),db=f.env.DB;
  db.db.exec(`CREATE TABLE provenance(id TEXT PRIMARY KEY,detail TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_tables VALUES('provenance','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES('evidence-detail','provenance','detail','text');`);
  const withEvidence={...input,operations:[...input.operations,{kind:'create',table:'provenance',id:'edge',expected_revision:null,values:{detail:'retained-proof'}}]};
  const p=await f.call(prefix+'preview',withEvidence,f.agent);expect(p.body.kind).toBe('success');
  const created=await f.call(prefix+'proposals/create',{previewToken:p.body.value.previewToken,idempotencyKey:'evidence-create'},f.agent);
  const a=await approveRequest(f,created.body.value),r=await f.call(prefix+'proposals/approve',a);
  expect(r.body.kind).toBe('success');expect(r.body.value.rows.length).toBe(3);
  expect(db.db.query('SELECT detail FROM provenance').get().detail).toBe('retained-proof');
  const row=db.db.query('SELECT updated_at,hub_at FROM provenance').get();
  const denied=await f.call(prefix+'preview',{operations:[{kind:'patch',table:'provenance',id:'edge',expected_revision:row,values:{detail:'overwrite'}}],reads:[]},f.agent);
  expect(denied.status).toBe(400);expect(db.db.query('SELECT detail FROM provenance').get().detail).toBe('retained-proof');
});

test('expired user preview produces a durable negative receipt and no mutations',async()=>{
  const {unseal,seal,configuration}=await import('../src/governance-preview.js');
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal),config=configuration(f.env);
  const binding=await unseal(config,a.previewToken);binding.expiresAt=old;
  const request={...a,previewToken:await seal(config,binding)};
  const r=await f.call(prefix+'proposals/approve',request);
  expect(r.status).toBe(409);expect(r.body).toMatchObject({code:'expired_preview',resolution:'not_committed'});
  expect((await f.call(prefix+'proposals/approve',request)).body).toEqual(r.body);
  expect(f.env.DB.db.query('SELECT label FROM buckets').get().label).toBe('whole');
});

test('new capability is distinct from single-row governance and operator identity has neither authority',async()=>{
  const f=await fixture();
  const session=async token=>(await (await hub.fetch(new Request('https://hub.test/v1/session',{headers:{Authorization:'Bearer '+token}}),f.env,{waitUntil(){}})).json());
  const agent=await session(f.agent),user=await session('user'),operator=await session('operator');
  expect(agent.capabilities.changesets).toMatchObject({protocol:'bounded-changeset-proposals-v1',authority:{propose:true,approve:false},limits:{maxOperations:64,maxTables:8}});
  expect(user.capabilities.changesets.authority.approve).toBe(true);
  expect(operator.capabilities.changesets).toBeUndefined();
  expect(user.capabilities.governance.protocol).toBe('selected-inverse-proposals-v1');
});


test('the initially displayed read membership cannot silently rebase at first preview',async()=>{
  const f=await fixture();
  f.env.DB.db.exec(`INSERT INTO entries VALUES('already-added','b',1,'${old}',NULL,NULL)`);
  const before=f.snapshot(),r=await f.call(prefix+'preview',input,f.agent);
  expect(r.status).toBe(409);expect(f.snapshot()).toEqual(before);
});


test('HTTP proposal and whole-set receipt fit enforced SQLite and D1 bounds',async()=>{
  const {LimitedD1}=await import('./limited-d1.js');
  const f=await fixture(),source=f.env.DB.db,db=new LimitedD1();
  try{
    const schema=source.query("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name").all();
    for(const row of schema){
      await db.prepare(row.sql).run();
      if(row.type==='table')for(const record of source.query('SELECT * FROM '+JSON.stringify(row.name)).all()){
        const cols=Object.keys(record);await db.prepare('INSERT INTO '+JSON.stringify(row.name)+' ('+cols.map(c=>JSON.stringify(c)).join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')').bind(...Object.values(record)).run();
      }
    }
    f.env.DB=db;
    const {proposal}=await propose(f),a=await approveRequest(f,proposal),r=await f.call(prefix+'proposals/approve',a);
    expect(r.status).toBe(200);expect(r.body.kind).toBe('success');expect(r.body.value.rows.map(r=>r.id)).toEqual(['e','b']);
    expect((await f.call(prefix+'proposals/approve',a)).body).toEqual(r.body);
  }finally{await db.close();}
});

test('failure at the final receipt statement rolls back writes, history and proposal state',async()=>{
  const f=await fixture(),{proposal}=await propose(f),a=await approveRequest(f,proposal),db=f.env.DB;
  const prepare=db.prepare.bind(db),batch=db.batch.bind(db);
  db.prepare=sql=>Object.assign(prepare(sql),{testSql:sql});
  let injected=false;
  db.batch=statements=>{
    if(statements.some(s=>s.testSql?.includes("SET state='approved'"))){
      injected=true;
      statements=statements.map(s=>s.testSql?.startsWith('INSERT INTO _governance_changeset_receipts')?prepare('SELECT abs(-9223372036854775808)'):s);
    }
    return batch(statements);
  };
  const r=await f.call(prefix+'proposals/approve',a);
  expect(injected).toBe(true);expect(r.body.kind).toBe('error');
  expect(db.db.query('SELECT label FROM buckets').get().label).toBe('whole');
  expect(db.db.query('SELECT * FROM entries').all()).toEqual([]);
  expect(db.db.query('SELECT state FROM _governance_changesets').get().state).toBe('pending');
  expect(db.db.query("SELECT count(*) n FROM _governance_history").get().n).toBe(0);
});

test('caller-supplied identity permits a native random ID default without evaluating it',async()=>{
  const f=await fixture();
  f.env.DB.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))),value TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_tables VALUES('items','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES('item-value','items','value','text');`);
  await f.call('schema/pull');
  const request={operations:[{kind:'create',table:'items',id:'fixed',expected_revision:null,values:{value:'retained'}}],reads:[]};
  const r=await f.call(prefix+'preview',request,f.agent);
  expect(r.body.kind).toBe('success');expect(r.body.value.changes[0].id).toBe('fixed');
});

test('canonical client consumes the actual service proposal, preview and approval receipts',async()=>{
  const {createChangesetAPI}=await import('../../core/src/changeset-client.ts');
  const f=await fixture();
  const session=async token=>(await (await hub.fetch(new Request('https://hub.test/v1/session',{headers:{Authorization:'Bearer '+token}}),f.env,{waitUntil(){}})).json());
  const client=async token=>createChangesetAPI((await session(token)).capabilities.changesets,async(route,body)=>{
    const r=await f.call(route.slice(4),body,token);return {status:r.status,data:r.body};
  });
  const agent=await client(f.agent),user=await client('user');
  const preview=await agent.preview(input);expect(preview.kind).toBe('success');
  const created=await agent.createProposal({previewToken:preview.value.previewToken,idempotencyKey:'client-create'});expect(created.kind).toBe('success');
  const p=created.value,shown=await user.getProposal({proposalId:p.id});expect(shown.kind).toBe('success');
  const approvalPreview=await user.previewProposal({proposalId:p.id,expectedVersion:p.version},p);expect(approvalPreview.kind).toBe('success');
  const args={proposalId:p.id,expectedVersion:p.version,previewToken:approvalPreview.value.previewToken,idempotencyKey:'client-approve'};
  const result=await user.approveProposal(args,p);expect(result.kind).toBe('success');
  expect(await user.approveProposal(args,p)).toEqual(result);
});
