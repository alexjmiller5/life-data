import { expect, test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { ROUTES } from '../src/index.js';

test('metadata rules reject undocumented changes without blocking legacy data edits', async () => {
  const db = new D1Shim();
  db.db.exec(`
    CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, type TEXT,
      description TEXT, label TEXT, sort INTEGER, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    CREATE TABLE catalog_rules (id TEXT PRIMARY KEY, tbl TEXT, kind TEXT, enforce INTEGER,
      sql TEXT, text TEXT, deleted_at TEXT);
    CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    INSERT INTO catalog_properties VALUES ('items.name','items','name','text',NULL,NULL,0,
      '2026-01-01T00:00:00.000Z',NULL,NULL);
  `);
  db.db.query('INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text) VALUES (?,?,?,?,?,?)').run(
    'descriptions','catalog_properties','invariant',1,
    "SELECT id FROM changed WHERE deleted_at IS NULL AND (description IS NULL OR trim(description, char(9)||char(10)||char(13)||' ') = '')",
    'Describe new or changed properties.',
  );
  const push = (table, row) => ROUTES['/v1/rows/push']({table,columns:Object.keys(row),rows:[row]}, db);
  const row = {id:'items.name',label:'Name',updated_at:'2026-01-02T00:00:00.000Z'};
  const bad = await push('catalog_properties',row);
  expect(bad.upserted).toBe(0);
  expect(bad.rejected).toHaveLength(1);
  expect(db.db.query('SELECT label FROM catalog_properties').get().label).toBeNull();
  expect((await push('items',{id:'one',name:'Item',updated_at:row.updated_at})).rejected).toEqual([]);
  expect((await push('catalog_properties',{...row,description:'Item display name.'})).rejected).toEqual([]);
  const clear = await push('catalog_properties',{
    ...row,description:' \t\n',updated_at:'2026-01-03T00:00:00.000Z',
  });
  expect(clear.upserted).toBe(0);
  expect(clear.rejected).toHaveLength(1);
  expect(db.db.query('SELECT description FROM catalog_properties').get().description).toBe('Item display name.');
  // Retirement is allowed, but restoration is a fresh definition claim.
  expect((await push('catalog_properties',{
    ...row,description:null,deleted_at:row.updated_at,updated_at:'2026-01-04T00:00:00.000Z',
  })).rejected).toEqual([]);
  expect((await push('catalog_properties',{
    ...row,deleted_at:null,updated_at:'2026-01-05T00:00:00.000Z',
  })).upserted).toBe(0);
  db.db.close();
});
