import { expect, test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { createSubscription } from '../src/subscriptions.js';
import { ROUTES } from '../src/index.js';

const time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function database() {
  const db=new D1Shim();
  db.db.exec(`CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,options TEXT,options_sql TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,alternate TEXT,created_at TEXT DEFAULT (${time}),updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_tables VALUES ('articles','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.url','articles','url','url'),('articles.alternate','articles','alternate','url');`);
  return db;
}
const config = {label:'Capture fixture',sources:[{table:'articles',columns:['url','alternate']}],start:'now'};
const rows = (db,id) => db.db.query('SELECT CAST(seq AS TEXT) AS seq,event_id,recorded_at,payload_json FROM _change_events WHERE subscription_id=? ORDER BY seq').all(id).map(r=>({...JSON.parse(r.payload_json),id:r.event_id,seq:r.seq,recorded_at:r.recorded_at}));
const write = (db,values) => ROUTES['/v1/rows/push']({table:'articles',columns:Object.keys(values),rows:[values]},db);
const change = (id,url,second=0,extra={}) => ({id,url,updated_at:`2026-10-03T00:00:${String(second).padStart(2,'0')}.000Z`,...extra});

test('activation records only subsequent accepted changes, including fast A-to-B and deletes',async()=>{
  const db=database();await write(db,change('existing','https://example.test/existing'));
  const sub=await createSubscription(db,config);
  expect(sub).toMatchObject({protocol:'durable-pull-v1',state:'active',acked_seq:'0',sources:config.sources});
  expect(rows(db,sub.id)).toEqual([]);
  await write(db,change('a','https://example.test/a',1));
  await write(db,change('a','https://example.test/b',2));
  await write(db,change('a','https://example.test/b',3,{deleted_at:'2026-10-03T00:00:03.000Z'}));
  const events=rows(db,sub.id);
  expect(events.map(e=>[e.seq,e.operation,e.changes])).toEqual([
    ['1','insert',[{column:'url',old_value:null,new_value:'https://example.test/a'}]],
    ['2','update',[{column:'url',old_value:'https://example.test/a',new_value:'https://example.test/b'}]],
    ['3','delete',[{column:'url',old_value:'https://example.test/b',new_value:null}]],
  ]);
  expect(new Set(events.map(e=>e.id)).size).toBe(3);
  expect(events[0].source.before_revision).toBeNull();
  expect(events[1].source.before_revision.updated_at).toBe('2026-10-03T00:00:01.000Z');
  expect(events[2].source.after_revision).toBeNull();
});

test('stale/noop/timestamp churn and rejected mutations never enqueue events',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  await write(db,change('a','https://example.test/a',1));
  await write(db,change('a','https://example.test/a',2));
  await write(db,change('a','https://example.test/stale',0));
  await write(db,change('a','not-a-url',3));
  expect(rows(db,sub.id)).toHaveLength(1);
  expect(db.db.query("SELECT url FROM articles WHERE id='a'").get().url).toBe('https://example.test/a');
});

test('transaction rollback rolls back the sequence and event, including nested timestamp triggers',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  db.db.exec(`CREATE TRIGGER articles_clock AFTER UPDATE ON articles WHEN OLD.updated_at=NEW.updated_at BEGIN UPDATE articles SET updated_at=(${time}) WHERE id=NEW.id; END`);
  await write(db,change('a','https://example.test/a',1));
  await db.prepare("UPDATE articles SET url='https://example.test/b' WHERE id='a'").run();
  expect(rows(db,sub.id)).toHaveLength(2);
  await expect(db.batch([db.prepare("UPDATE articles SET url='https://example.test/c' WHERE id='a'"),db.prepare('INSERT INTO missing VALUES (1)')])).rejects.toThrow();
  expect(rows(db,sub.id)).toHaveLength(2);
  expect(db.db.query('SELECT last_seq FROM _change_subscriptions').get().last_seq).toBe(2);
  await db.prepare("DELETE FROM articles WHERE id='a'").run();
  expect(rows(db,sub.id).at(-1).operation).toBe('delete');
});

test('subscriptions have independent sequences; paused records, retired stops',async()=>{
  const db=database(),first=await createSubscription(db,config);
  await write(db,change('a','https://example.test/a',1));
  const second=await createSubscription(db,{...config,sources:[{table:'articles',columns:['alternate']}]});
  db.db.exec(`UPDATE _change_subscriptions SET state='paused' WHERE id='${first.id}'`);
  await write(db,change('a','https://example.test/b',2,{alternate:'https://example.test/alt'}));
  expect(rows(db,first.id).map(e=>e.seq)).toEqual(['1','2']);
  expect(rows(db,second.id).map(e=>e.seq)).toEqual(['1']);
  db.db.exec(`UPDATE _change_subscriptions SET state='retired' WHERE id='${first.id}'`);
  await write(db,change('a','https://example.test/c',3));
  expect(rows(db,first.id)).toHaveLength(2);
});

test('capacity and oversize events reject the mutation without sequence gaps',async()=>{
  const db=database(),sub=await createSubscription(db,{...config,max_pending_events:1});
  await write(db,change('a','https://example.test/a',1));
  const result=await write(db,change('a','https://example.test/b',2));
  expect(result.upserted).toBe(0);
  expect(result.rejected[0]).toMatchObject({rule:'outbox-capacity',retryable:true});
  expect(rows(db,sub.id)).toHaveLength(1);
  expect(db.db.query("SELECT url FROM articles WHERE id='a'").get().url).toBe('https://example.test/a');
  const other=database();await createSubscription(other,config);
  const large=await write(other,change('a','https://example.test/'+ 'x'.repeat(1_048_576),1));
  expect(large.rejected[0].rule).toBe('outbox-event-size');
  expect(other.db.query('SELECT count(*) AS n FROM articles').get().n).toBe(0);
});

test('accepted derivations record values and the exact committed source revision',async()=>{
  const {deriveRows}=await import('../src/derive.js');
  const db=database();
  db.db.exec(`CREATE TABLE provenance(id TEXT PRIMARY KEY,to_kind TEXT,to_ref TEXT,field TEXT,from_kind TEXT,from_ref TEXT,rel TEXT,asserted_by TEXT,inputs_hash TEXT,value_hash TEXT,produced_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.id','articles','id','text');
    UPDATE catalog_properties SET derived_by='http:fixture',inputs='["id"]' WHERE id='articles.url';
    INSERT INTO articles(id,updated_at) VALUES ('a','2026-10-03T00:00:00.000Z');`);
  const sub=await createSubscription(db,config);
  const out=await deriveRows(db,{DERIVATIONS:JSON.stringify({fixture:{url:'https://derive.example.test/'}})},'articles',['a'],{
    fetchImpl:async()=>Response.json({url:'https://example.test/derived'}),
  });
  expect(out).toEqual({derived:1,failed:[]});
  const [event]=rows(db,sub.id),actual=db.db.query("SELECT updated_at,hub_at FROM articles WHERE id='a'").get();
  expect(event.changes).toEqual([{column:'url',old_value:null,new_value:'https://example.test/derived'}]);
  expect(event.source.after_revision).toEqual(actual);
});

test('schema replay cannot silently drop or change watched tables or their recording triggers',async()=>{
  const db=database();db.db.exec('CREATE TABLE _schema_log(id INTEGER PRIMARY KEY,applied_at TEXT,ddl TEXT)');
  const sub=await createSubscription(db,config);
  const {name}=db.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_insert'").get();
  for(const ddl of ['DROP TABLE articles','ALTER TABLE articles RENAME COLUMN url TO different',`DROP TRIGGER "${name}"`]) {
    const response=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl}]},db);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('subscription_schema_conflict');
  }
  const out=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl:'CREATE TABLE unrelated(id TEXT PRIMARY KEY)'}]},db);
  expect(out.applied).toBe(1);
  await write(db,change('a','https://example.test/a',1));
  expect(rows(db,sub.id)).toHaveLength(1);
});

test('multi-column changes, empty URLs and restoration preserve exact accepted values',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  await write(db,change('a','https://example.test/a',1,{alternate:'https://example.test/alt'}));
  await write(db,change('a','',2,{alternate:null}));
  expect(rows(db,sub.id).at(-1).changes).toEqual([
    {column:'url',old_value:'https://example.test/a',new_value:''},
    {column:'alternate',old_value:'https://example.test/alt',new_value:null},
  ]);
  await write(db,change('a','https://example.test/restored',3,{deleted_at:'2026-10-03T00:00:03.000Z'}));
  await write(db,change('a','https://example.test/restored',4,{deleted_at:null}));
  expect(rows(db,sub.id).at(-1).changes).toEqual([{column:'url',old_value:null,new_value:'https://example.test/restored'}]);
});

test('invalid selector activation leaves no subscription or recording triggers',async()=>{
  const db=database();
  for(const bad of [{...config,start:'all'},{...config,sources:[{table:'articles',columns:['missing']}]},{...config,sources:[{table:'articles',columns:['updated_at']}]},{...config,max_pending_events:0}]) {
    await expect(createSubscription(db,bad)).rejects.toThrow();
  }
  expect(db.db.query('SELECT count(*) AS n FROM _change_subscriptions').get().n).toBe(0);
  expect(db.db.query("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n).toBe(0);
});
