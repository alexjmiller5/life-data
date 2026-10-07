import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import { setup, T0, T1 } from './support.ts';

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
async function fixture() {
  const { db, remote, hub } = setup();
  closes.push(() => db.db.close(), () => remote.db.close());
  const ddl = 'CREATE TABLE catalog_tables(id TEXT PRIMARY KEY, kind TEXT, display TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)';
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query('INSERT INTO catalog_tables VALUES (?,?,?,?,?,?)').run('items','table','name',T0,null,T1);
  remote.db.query('INSERT INTO items VALUES (?,?,?,?,?,?,?)').run('r','Before',1,T0,T0,null,T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,derived_by,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('items.name','items','name','text','http:fixture',T0,T1);
  await core.sync(db,hub);
  const calls: { route: string; body: any }[] = [];
  const control: { response: unknown; beforeReply?: () => Promise<void> } = { response: { derived: 1, failed: [] } };
  const transport: core.Hub = { endpoint: hub.endpoint, async post(route,body) {
    calls.push({route,body});
    if (route !== '/v1/derive/resolve') return hub.post(route,body);
    await control.beforeReply?.();
    return { data: control.response };
  }};
  return {db,remote,transport,calls,control,args:{table:'items',id:'r',column:'name',expectedUpdatedAt:T0}};
}

test('Resolve sends one named hub derivation and never writes returned values into the replica', async () => {
  const {db,transport,calls,args} = await fixture();
  const before = db.db.serialize();
  expect(await core.resolveDerived(db,transport,args)).toEqual({derived:1,failed:[]});
  expect(calls.at(-1)).toEqual({route:'/v1/derive/resolve',body:{table:'items',ids:['r'],col:'name',expectedUpdatedAt:T0}});
  expect(db.db.serialize()).toEqual(before);
});

test.each(['local revision','hub revision','not derived','deleted','wrong hub'])('Resolve rejects %s before sending a derivation', async kind => {
  const {db,remote,transport,calls,args} = await fixture();
  if(kind==='local revision') db.db.query('UPDATE items SET updated_at=?').run(T1);
  if(kind==='hub revision') remote.db.query('UPDATE items SET updated_at=?').run(T1);
  if(kind==='not derived') db.db.exec('UPDATE catalog_properties SET derived_by=NULL');
  if(kind==='deleted') db.db.query('UPDATE items SET deleted_at=?').run(T1);
  if(kind==='wrong hub') transport.endpoint='https://wrong.example';
  await expect(core.resolveDerived(db,transport,args)).rejects.toThrow();
  expect(calls.filter(c=>c.route==='/v1/derive/resolve')).toHaveLength(0);
});

test('Resolve retains structured hub failure instead of claiming a saved result', async () => {
  const {db,transport,control,args} = await fixture();
  control.response={derived:0,failed:[{id:'r',col:'name',error:'Provider unavailable',status:503,retry_after:60}]};
  expect(await core.resolveDerived(db,transport,args)).toEqual({derived:0,failed:[{id:'r',col:'name',error:'Provider unavailable',status:503,retry_after:60}]});
  expect((await db.all('SELECT name FROM items'))[0].name).toBe('Before');
});

test.each([{derived:-1,failed:[]},{derived:1,failed:[{id:'other',col:'name',error:'Wrong row'}]},{derived:1,failed:null}])('Resolve rejects malformed receipt %j', async response => {
  const {db,transport,control,args} = await fixture();control.response=response;
  await expect(core.resolveDerived(db,transport,args)).rejects.toThrow('Invalid derivation response');
});

test('Resolve rejects a local edit admitted during HTTP without replacing it', async () => {
  const {db,transport,control,args} = await fixture();
  control.beforeReply=async()=>{await db.run('UPDATE items SET name=?,updated_at=?',['Concurrent edit',T1]);};
  await expect(core.resolveDerived(db,transport,args)).rejects.toThrow('changed');
  expect((await db.all('SELECT name FROM items'))[0].name).toBe('Concurrent edit');
});
