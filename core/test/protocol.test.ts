import { expect, test } from 'bun:test';
import cases from '../../tests/fixtures/sync-protocol/revisions.json';
import { sync } from '../src/sync.ts';
import { setup, T0 } from './support.ts';

for (const c of cases) test(`shared revision protocol: ${c.name}`,async()=>{
  const {db,hub,remote}=setup();
  await sync(db,hub);
  await db.run("UPDATE _core_sync SET push=''");
  const sql='INSERT INTO items(id,name,updated_at,deleted_at,hub_at) VALUES (?,?,?,?,?)';
  await db.run(sql,[...Object.values(c.local),T0]);
  remote.db.query(sql).run(...Object.values(c.remote),T0);
  expect((await sync(db,hub)).rejected).toEqual([]);
  expect(await db.all('SELECT id,name,updated_at,deleted_at FROM items')).toEqual([c.expected]);
  expect(remote.db.query('SELECT id,name,updated_at,deleted_at FROM items').all()).toEqual([c.expected]);
  expect((await sync(db,hub)).pulled).toBe(0);
});
