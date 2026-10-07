import {expect,test} from 'bun:test';
import worker from '../src/index.js';
import {ensureAuthReady,hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';

async function fixture(collation='BINARY'){
 const DB=new D1Shim(),AUTH_DB=new D1Shim();
 DB.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY COLLATE ${collation},title TEXT,released TEXT,saved INTEGER,private TEXT,updated_at TEXT,deleted_at TEXT);
 CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
 INSERT INTO catalog_tables VALUES ('items','table',NULL);
 INSERT INTO items VALUES ('a','Alpha','2026-01-01',0,'secret','r',NULL),('b','Beta','2026-01-01',1,'secret','r',NULL),('c','Gamma','2026-01-02',1,'secret','r',NULL),('d','Delta',NULL,0,'secret','r',NULL),('e','Deleted','2026-01-03',0,'secret','r','gone');`);
 await ensureAuthReady(AUTH_DB);
 const scopes=['id','title','released','saved','updated_at','deleted_at'].map(c=>'tables:read:items:'+c);
 AUTH_DB.db.query('INSERT INTO _tokens(hash,name,scopes) VALUES (?,?,?)').run(await hashToken('reader'),'reader',scopes.join(','));
 const env={HUB_TOKEN:'root',DB,AUTH_DB};
 const call=body=>worker.fetch(new Request('https://hub.test/v1/rows/query',{method:'POST',headers:{Authorization:'Bearer reader'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 return {DB,env,call};
}
const query={table:'items',columns:['id','title','released'],filter:{column:'deleted_at',op:'is_null',value:true},order:[{column:'released',direction:'asc'}],limit:2};
async function pages(call,body){
 const ids=[];let cursor;
 do{
  const response=await call({...body,...(cursor?{cursor}:{})});
  expect(response.status).toBe(200);
  const page=await response.json();ids.push(...page.rows.map(r=>r.id));cursor=page.next_cursor;
 }while(cursor);
 return ids;
}

test('bounded queries page equal and null dates without duplicates and honor tombstone predicates',async()=>{
 const {call}=await fixture();
 const first=await call(query);expect(first.status).toBe(200);
 const page=await first.json();expect(page.rows.map(r=>r.id)).toEqual(['a','b']);expect(page.next_cursor).toBeString();
 expect(await pages(call,{...query,cursor:page.next_cursor})).toEqual(['c','d']);
 expect(await pages(call,{...query,order:[{column:'released',direction:'desc'}]})).toEqual(['c','a','b','d']);
});

test('queries authorize every projected predicate and sort column before data access',async()=>{
 const {call,env}=await fixture();env.DB={prepare(){throw Error('forbidden data read');}};
 for(const body of [{...query,columns:['id','private']},{...query,order:[{column:'private',direction:'asc'}]},{...query,filter:{column:'private',op:'eq',value:'secret'}}])expect((await call(body)).status).toBe(403);
});

test('bounded AST rejects SQL, deep expressions, excessive IN, invalid sorts and page sizes',async()=>{
 const {call}=await fixture();let deep={column:'saved',op:'eq',value:1};for(let i=0;i<5;i++)deep={and:[deep]};
 for(const body of [{...query,sql:'SELECT private FROM items'},{...query,filter:'saved=1'},{...query,filter:deep},{...query,filter:{column:'id',op:'in',value:Array(201).fill('a')}},{...query,limit:201},{...query,limit:0},{...query,order:[{column:'id',direction:'asc; SELECT 1'}]},{...query,filter:{and:Array(65).fill({column:'saved',op:'eq',value:1})}}])expect((await call(body)).status).toBe(400);
});

test('cursor binds predicates, order, projection and table shape',async()=>{
 const {call,DB}=await fixture();
 const first=await call(query);expect(first.status).toBe(200);const {next_cursor:cursor}=await first.json();
 for(const change of [{filter:{column:'saved',op:'eq',value:1}},{order:[{column:'released',direction:'desc'}]},{columns:['id']}])expect((await call({...query,...change,cursor})).status).toBe(409);
 DB.db.exec('ALTER TABLE items ADD COLUMN extra TEXT');
 expect((await call({...query,cursor})).status).toBe(409);
});

test('OR, literal substring and large IN stay parameterized and traverse NOCASE identities',async()=>{
 const {call,DB}=await fixture('NOCASE');DB.db.exec("UPDATE items SET id='B' WHERE id='b'");
 expect(await pages(call,{...query,filter:{or:[{column:'saved',op:'eq',value:1},{column:'id',op:'eq',value:'d'}]}})).toEqual(['B','c','d']);
 expect(await pages(call,{...query,filter:{column:'title',op:'contains',value:'%'}})).toEqual([]);
 expect(await pages(call,{...query,filter:{column:'id',op:'in',value:['a','b',...Array.from({length:198},(_,i)=>'missing'+i)]}})).toEqual(['a','B']);
});

test('identity tie-breaker retains every item when equal-date groups span pages',async()=>{
 const {call}=await fixture();expect(await pages(call,{...query,limit:1})).toEqual(['a','b','c','d']);
});

test('nullable identities and unsafe numeric cursor values fail explicitly',async()=>{
 const {call,DB}=await fixture();DB.db.exec("INSERT INTO items(id,title,released,updated_at) VALUES (NULL,'No identity',NULL,'r')");
 expect((await call({...query,limit:200})).status).toBe(409);
 DB.db.exec('DELETE FROM items WHERE id IS NULL');
 DB.db.exec('UPDATE items SET saved=9223372036854775807');
 expect((await call({...query,order:[{column:'saved',direction:'asc'}]})).status).toBe(409);
});

test('schema drift while querying rejects the read instead of trusting stale inspection',async()=>{
 const {call,DB}=await fixture(),batch=DB.batch.bind(DB);
 DB.batch=async statements=>{DB.db.exec("UPDATE catalog_tables SET kind='view'");return batch(statements);};
 expect((await call(query)).status).toBe(409);
});

test('quarter-million synthetic catalog returns bounded indexed pages',async()=>{
 const {call,DB}=await fixture();
 DB.db.exec("DELETE FROM items; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<250000) INSERT INTO items(id,title,released,updated_at) SELECT printf('%08d',i),'Synthetic item','2026-01-01','r' FROM n; CREATE INDEX items_feed ON items(deleted_at,released IS NULL,released,id IS NULL,id)");
 const statements=[],prepare=DB.prepare.bind(DB);
 DB.prepare=sql=>{const stmt=prepare(sql),bind=stmt.bind;let args=[];stmt.bind=(...v)=>{args=v;return bind.call(stmt,...v);};if(sql.startsWith('SELECT "id"'))statements.push({sql,args:()=>args});return stmt;};
 const start=performance.now(),response=await call({...query,limit:50}),data=await response.json();
 expect(response.status).toBe(200);expect(data.rows).toHaveLength(50);expect(data.rows[0].id).toBe('00000001');expect(data.rows.at(-1).id).toBe('00000050');
 const statement=statements.at(-1),plan=DB.db.query('EXPLAIN QUERY PLAN '+statement.sql).all(...statement.args()).map(r=>r.detail).join('\n');
 expect(plan).toContain('USING INDEX items_feed');expect(plan).not.toContain('TEMP B-TREE');
 console.info(JSON.stringify({fixtureRows:250000,pageRows:data.rows.length,requestBytes:JSON.stringify({...query,limit:50}).length,responseBytes:JSON.stringify(data).length,elapsedMs:Math.round(performance.now()-start),plan}));
},10000);
