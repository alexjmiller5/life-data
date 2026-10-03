import { afterEach, expect, test } from 'bun:test';
import { writeRow, ValidationError } from '../src/write.ts';
import { sync } from '../src/sync.ts';
import { schema, setup, TestSql, T0, T1 } from './support.ts';
import { qident, type Row } from '../src/validate.ts';

const databases: { close(): void }[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const clock = { now: () => new Date(T1), id: () => 'item-1', origin: 'test-device' };
async function local() {
  const db = new TestSql();
  databases.push(db.db);
  for (const ddl of schema) await db.run(ddl);
  await property(db, 'name', { type: 'text', required: 1 });
  await property(db, 'qty', { type: 'int' });
  return db;
}
async function property(db: TestSql, col: string, fields: Row) {
  await db.run('INSERT OR IGNORE INTO catalog_properties(id,tbl,col) VALUES (?,?,?)', [`items.${col}`, 'items', col]);
  for (const [key, value] of Object.entries(fields)) {
    await db.run(`UPDATE catalog_properties SET ${qident(key)}=? WHERE id=?`, [value as string | number | null, `items.${col}`]);
  }
}
async function rejects(action: Promise<unknown>, rule: string, col?: string) {
  let error: unknown;
  try { await action; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ValidationError);
  const violations = (error as ValidationError).violations;
  expect(violations.some(v => v.rule === rule && (col === undefined || v.col === col))).toBe(true);
  return error as ValidationError;
}

test('create applies catalog and physical defaults before actual SQLite validation, preserving explicit NULL', async () => {
  const db = await local();
  await db.run("ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'physical'");
  await property(db, 'note', { type: 'text' });
  await property(db, 'name', { default_value: 'Default' });
  await property(db, 'qty', { default_value: 'sql:2 + 3' });
  const created = await writeRow(db, 'items', {}, clock);
  expect(created).toMatchObject({ id: 'item-1', name: 'Default', qty: 5, note: 'physical', created_at: T1, updated_at: T1, hub_at: null });
  const explicit = await writeRow(db, 'items', { qty: null, note: null }, { ...clock, id: () => 'item-2' });
  expect(explicit).toMatchObject({ qty: null, note: null });
  await rejects(writeRow(db, 'items', { name: null }, { ...clock, id: () => 'bad' }), 'required', 'name');
  expect(await db.all('SELECT id FROM items ORDER BY id')).toEqual([{ id: 'item-1' }, { id: 'item-2' }]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('patch merges without overwriting omitted cells and each revision increases even with clock rollback', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before', qty: 7 }, clock);
  await property(db, 'qty', { default_value: '100' });
  const edited = await writeRow(db, 'items', { id: 'item-1', name: 'After' }, { ...clock, now: () => new Date(Date.parse(T1) - 1) });
  expect(edited).toMatchObject({ qty: 7, created_at: T1, updated_at: '2026-01-02T00:00:00.001Z' });
  const noop = await writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock);
  expect(noop.updated_at).toBe('2026-01-02T00:00:00.002Z');
  expect(await db.all('SELECT col,old,new FROM history')).toEqual([{ col: 'name', old: 'Before', new: 'After' }]);
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'Backdated' }, { ...clock, now: () => new Date(T0) }), 'clock', 'updated_at');
  expect(await db.all('SELECT * FROM items')).toEqual([noop]);
});

test('validation rolls back the actual update and history, including merged required and derived fields', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before', qty: 4 }, clock);
  const before = await db.all('SELECT * FROM items');
  await rejects(writeRow(db, 'items', { id: 'item-1', name: null, qty: 5 }, clock), 'required', 'name');
  await rejects(writeRow(db, 'items', { id: 'item-1', qty: 'not a number' }, clock), 'type', 'qty');
  await property(db, 'qty', { derived_by: 'http:fixture', inputs: '["name"]' });
  await rejects(writeRow(db, 'items', { id: 'item-1', qty: 5 }, clock), 'derived', 'qty');
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  await db.run('UPDATE items SET name=NULL');
  await rejects(writeRow(db, 'items', { id: 'item-1', qty: 4 }, clock), 'required', 'name');
});

test('SQLite affinity precedes validation and history uses exact SQLite text casts, including NULL', async () => {
  const db = await local();
  await db.run('ALTER TABLE items ADD COLUMN amount REAL');
  await db.run('ALTER TABLE items ADD COLUMN flag INTEGER');
  await db.run('ALTER TABLE items ADD COLUMN "order" TEXT');
  await property(db, 'amount', { type: 'number' });
  await property(db, 'flag', { type: 'bool' });
  await property(db, 'order', { type: 'text' });
  const created = await writeRow(db, 'items', { name: 'Initial', qty: '03', amount: 4, flag: '1', order: 'safe' }, clock);
  expect(created).toMatchObject({ qty: 3, amount: 4, flag: 1 });
  const edited = await writeRow(db, 'items', { id: 'item-1', qty: '3', amount: '5', order: "x'); DROP TABLE items; --", name: null, deleted_at: true }, clock);
  expect(edited).toMatchObject({ amount: 5, deleted_at: '2026-01-02T00:00:00.001Z' });
  expect(await db.all('SELECT col,old,new,origin FROM history ORDER BY col')).toEqual([
    { col: 'amount', old: '4.0', new: '5.0', origin: 'test-device' },
    { col: 'deleted_at', old: null, new: '2026-01-02T00:00:00.001Z', origin: 'test-device' },
    { col: 'name', old: 'Initial', new: null, origin: 'test-device' },
    { col: 'order', old: 'safe', new: "x'); DROP TABLE items; --", origin: 'test-device' },
  ]);
  await rejects(writeRow(db, 'items', { id: 'item-1', deleted_at: null }, clock), 'required', 'name');
  expect((await writeRow(db, 'items', { id: 'item-1', name: 'Restored', deleted_at: null }, clock)).deleted_at).toBeNull();
});

test('original cell events survive a real worker round trip and repeated sync without duplicates', async () => {
  const { db, remote, hub, requests } = setup();
  databases.push(db.db, remote.db);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('items.name', 'items', 'name', 'text', 1, T0, T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('items.qty', 'items', 'qty', 'int', T0, T1);
  remote.db.query('INSERT INTO items(id,name,qty,created_at,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('a', 'Before', 1, T0, T0, T1);
  await sync(db, hub);
  const future = new Date(Date.now() + 20);
  await writeRow(db, 'items', { id: 'a', name: 'After', qty: '2' }, { now: () => future, origin: 'replica' });
  await rejects(writeRow(db, 'items', { id: 'a', name: null }, { now: () => future }), 'required');
  const originals = await db.all('SELECT id,col,old,new,origin,created_at,updated_at FROM history ORDER BY col');
  expect(originals).toHaveLength(2);
  expect((await sync(db, hub, { tables: { history: false } })).rejected).toEqual([]);
  expect(requests.some(r => r.route === '/v1/rows/push' && r.body.table === 'items' && r.body.history?.length === 2)).toBe(true);
  expect(remote.db.query('SELECT name,qty FROM items').get()).toEqual({ name: 'After', qty: 2 });
  expect(remote.db.query('SELECT id,col,old,new,origin,created_at,updated_at FROM history ORDER BY col').all()).toEqual(originals);
  const other = new TestSql(); databases.push(other.db);
  await sync(other, hub);
  expect(await other.all('SELECT name,qty FROM items')).toEqual([{ name: 'After', qty: 2 }]);
  expect(await other.all('SELECT id,col,old,new,origin,created_at,updated_at FROM history ORDER BY col')).toEqual(originals);
  await sync(db, hub);
  await sync(db, hub);
  expect(await db.all('SELECT id,col,old,new,origin,created_at,updated_at FROM history ORDER BY col')).toEqual(originals);
  expect(remote.db.query('SELECT count(*) AS n FROM history').get()).toEqual({ n: 2 });
});

test('missing ids create with SQLite randomness; explicit ids only select existing rows', async () => {
  const db = await local();
  const created = await writeRow(db, 'items', { name: 'Generated' }, { now: clock.now });
  expect(created.id).toMatch(/^[a-f0-9]{32}$/);
  await rejects(writeRow(db, 'items', { id: 'missing', name: 'Typo' }, clock), 'not_found', 'id');
  await rejects(writeRow(db, 'items', { id: null, name: 'Null id' }, clock), 'input', 'id');
  await rejects(writeRow(db, 'items', { name: 'Collision' }, { ...clock, id: () => String(created.id) }), 'storage');
  expect(await db.all('SELECT count(*) AS n FROM items')).toEqual([{ n: 1 }]);
});

test('system tables and timestamps, uncataloged columns, unsafe identifiers and non-data input are rejected', async () => {
  const db = await local();
  for (const table of ['catalog_properties', 'CATALOG_RULES', 'history', 'provenance', '_core_state', 'sqlite_master']) {
    await rejects(writeRow(db, table, {}, clock), 'read_only');
  }
  for (const table of ['missing', 'items; DELETE FROM items']) {
    await rejects(writeRow(db, table, {}, clock), table === 'missing' ? 'schema' : 'identifier');
  }
  for (const col of ['created_at', 'updated_at', 'hub_at']) {
    await rejects(writeRow(db, 'items', { name: 'Test', [col]: T0 }, clock), 'read_only', col);
  }
  await db.run('ALTER TABLE items ADD COLUMN uncataloged TEXT');
  for (const col of ['unknown', 'uncataloged']) await rejects(writeRow(db, 'items', { name: 'Test', [col]: 'x' }, clock), 'column', col);
  for (const value of [undefined, NaN, Infinity, {}, [], () => 1]) {
    await rejects(writeRow(db, 'items', { name: 'Test', qty: value }, clock), 'input', 'qty');
  }
  await rejects(writeRow(db, 'items', { name: 'Test', deleted_at: T0 }, clock), 'input', 'deleted_at');
  await rejects(writeRow(db, 'items', Object.assign(Object.create({ name: 'Inherited' }), { qty: 1 }), clock), 'input');
  expect(await db.all('SELECT * FROM items')).toEqual([]);
});

test('catalog options and inputs are parsed and arrays are stored as JSON', async () => {
  const db = await local();
  await db.run('ALTER TABLE items ADD COLUMN labels TEXT');
  await property(db, 'labels', { type: 'multi_select', options: '[{"v":"one"},{"v":"two"}]', inputs: '[]', default_value: '["one"]' });
  await property(db, 'name', { type: 'select', options: '[{"v":"Fixed"}]', options_sql: "SELECT 'Dynamic'" });
  expect((await writeRow(db, 'items', { name: 'Dynamic', labels: ['two'] }, clock)).labels).toBe('["two"]');
  await rejects(writeRow(db, 'items', { id: 'item-1', labels: ['invalid'] }, clock), 'options', 'labels');
  await property(db, 'labels', { inputs: 'broken json' });
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'Fixed' }, clock), 'catalog');
});

test('references fail honestly for unknown, skipped, missing and deleted rows', async () => {
  const db = await local();
  await property(db, 'name', { type: 'ref', ref_table: 'targets' });
  let error = await rejects(writeRow(db, 'items', { name: 'target' }, clock), 'ref', 'name');
  expect(error.message).toContain('replica');
  await db.run('CREATE TABLE targets(id TEXT PRIMARY KEY, deleted_at TEXT)');
  error = await rejects(writeRow(db, 'items', { name: 'target' }, clock), 'ref', 'name');
  expect(error.message).toContain('sync');
  await db.run('INSERT INTO targets VALUES (?,?)', ['target', T0]);
  await rejects(writeRow(db, 'items', { name: 'target' }, clock), 'ref');
  await db.run('UPDATE targets SET deleted_at=NULL');
  expect((await writeRow(db, 'items', { name: 'target' }, clock)).name).toBe('target');
  await property(db, 'name', { ref_table: null });
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'target' }, clock), 'catalog');
});

test('unbound enforced invariants require coverage, even for soft deletion', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before' }, clock);
  await db.run("INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text) VALUES ('nonempty','items','invariant',1,'SELECT id FROM changed WHERE name IS NULL','Name required')");
  const error = await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'coverage');
  expect(error.message).toContain('coverage');
  expect(error.message).toContain('CLI');
  await rejects(writeRow(db, 'items', { id: 'item-1', deleted_at: true }, clock), 'coverage');
  expect(await db.all('SELECT name FROM items')).toEqual([{ name: 'Before' }]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  await db.run('UPDATE catalog_rules SET enforce=0');
  expect((await writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock)).name).toBe('After');
});

test('missing catalog or history never silently skips validation or loses events', async () => {
  const db = await local();
  await db.run('DELETE FROM catalog_properties');
  await rejects(writeRow(db, 'items', { name: 'Unknown' }, clock), 'catalog');
  await property(db, 'name', { type: 'text' });
  await writeRow(db, 'items', { name: 'Before' }, clock);
  await db.run('DROP TABLE history');
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'schema');
  expect(await db.all('SELECT name FROM items')).toEqual([{ name: 'Before' }]);
  await db.run('DROP TABLE catalog_rules');
  await rejects(writeRow(db, 'items', { name: 'No rules' }, clock), 'schema');
});

test('timestamp boundaries reject far-future and malformed priors without poisoning the next write', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Initial' }, clock);
  const boundary = '2026-01-02T00:05:00.000Z';
  await db.run('UPDATE items SET updated_at=?', [boundary]);
  expect((await writeRow(db, 'items', { id: 'item-1', name: 'Boundary' }, clock)).updated_at).toBe('2026-01-02T00:05:00.001Z');
  for (const prior of ['2026-01-02T00:05:00.001Z', '2026-01-02T00:00:00Z', '2026-02-30T00:00:00.000Z', null]) {
    await db.run('UPDATE items SET updated_at=?', [prior]);
    const before = await db.all('SELECT * FROM items');
    const history = await db.all('SELECT * FROM history');
    await rejects(writeRow(db, 'items', { id: 'item-1', name: 'Rejected' }, clock), 'clock', 'updated_at');
    expect(await db.all('SELECT * FROM items')).toEqual(before);
    expect(await db.all('SELECT * FROM history')).toEqual(history);
  }
  await db.run('UPDATE items SET updated_at=?', [T0]);
  expect((await writeRow(db, 'items', { id: 'item-1', name: 'Recovered' }, clock)).updated_at).toBe(T1);
  for (const now of [() => new Date(NaN), () => new Date('0000-01-01T00:00:00.000Z')]) {
    await rejects(writeRow(db, 'items', { id: 'item-1', name: 'Bad clock' }, { now }), 'clock');
  }
  const early = '1969-12-31T23:59:59.000Z';
  expect((await writeRow(db, 'items', { name: 'Earlier clock' }, { now: () => new Date(early) })).updated_at).toBe(early);
});

test('custom data and history triggers fail closed before any values change', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before', qty: 2 }, clock);
  await property(db, 'qty', { immutable: 1 });
  await db.run("CREATE TRIGGER alter_qty AFTER UPDATE OF name ON items BEGIN UPDATE items SET qty=9 WHERE id=NEW.id; END");
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'trigger');
  expect(await db.all('SELECT name,qty FROM items')).toEqual([{ name: 'Before', qty: 2 }]);
  await db.run('DROP TRIGGER alter_qty');
  await db.run("CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT,'history unavailable'); END");
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'trigger');
  expect(await db.all('SELECT name,qty FROM items')).toEqual([{ name: 'Before', qty: 2 }]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  await db.run('DROP TRIGGER reject_history');
  expect((await writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock)).name).toBe('After');
});

test('table and column keywords and prototype-shaped columns remain ordinary parameterized data', async () => {
  const db = await local();
  await db.run('ALTER TABLE items ADD COLUMN "__proto__" TEXT');
  await property(db, '__proto__', { type: 'text' });
  const created = await writeRow(db, 'items', JSON.parse('{"name":"Before","__proto__":"initial"}'), clock);
  expect(created.__proto__).toBe('initial');
  await db.run('ALTER TABLE items RENAME TO "order"');
  await db.run("UPDATE catalog_properties SET tbl='order'");
  expect((await writeRow(db, 'order', { id: 'item-1', name: 'After' }, clock)).name).toBe('After');
});

test('system-column trigger tampering cannot bypass validation by making a hidden tombstone', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before' }, clock);
  await db.run("CREATE TRIGGER hidden_tombstone AFTER UPDATE ON items WHEN NEW.deleted_at IS NULL BEGIN UPDATE items SET deleted_at=NEW.updated_at WHERE id=NEW.id; END");
  await rejects(writeRow(db, 'items', { id: 'item-1', name: null }, clock), 'trigger');
  expect(await db.all('SELECT name,deleted_at FROM items')).toEqual([{ name: 'Before', deleted_at: null }]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('row and event IDs require no host crypto global', async () => {
  const db = await local();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    const created = await writeRow(db, 'items', { name: 'Before' }, { now: clock.now });
    expect(created.id).toMatch(/^[a-f0-9]{32}$/);
    await writeRow(db, 'items', { id: created.id, name: 'After' }, { now: clock.now });
    const history = await db.all('SELECT id FROM history');
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toMatch(/^[a-f0-9]{32}$/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

for (const destination of ['items', 'peers']) test(`trigger effects on immutable ${destination} rows fail closed, including other-table invariants`, async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before', qty: 2 }, clock);
  if (destination === 'peers') {
    await db.run('CREATE TABLE peers AS SELECT * FROM items WHERE 0');
    await db.run("INSERT INTO catalog_properties(id,tbl,col,type,immutable) VALUES ('peers.qty','peers','qty','int',1)");
    await db.run("INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text) VALUES ('peer-rule','peers','invariant',1,'SELECT id FROM changed WHERE qty!=2','Immutable quantity')");
  } else await property(db, 'qty', { immutable: 1 });
  await db.run(`INSERT INTO ${qident(destination)} (id,name,qty,created_at,updated_at) VALUES (?,?,?,?,?)`, ['item-2', 'Unchanged', 2, T1, T1]);
  const before = await db.all('SELECT * FROM items ORDER BY id');
  const peers = await db.all(`SELECT * FROM ${qident(destination)} ORDER BY id`);
  await db.run(`CREATE TRIGGER mutate_peer AFTER UPDATE ON items WHEN NEW.id='item-1'
    BEGIN UPDATE ${qident(destination)} SET qty=9 WHERE id='item-2'; END`);
  const error = await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'trigger');
  expect(error.message).toContain('mutate_peer');
  expect(await db.all('SELECT * FROM items ORDER BY id')).toEqual(before);
  expect(await db.all(`SELECT * FROM ${qident(destination)} ORDER BY id`)).toEqual(peers);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

for (const temporary of [false, true]) test(`history trigger cannot mutate validated rows after logging (temporary=${temporary})`, async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before', qty: 2 }, clock);
  const before = await db.all('SELECT * FROM items');
  await db.run(`CREATE ${temporary ? 'TEMP ' : ''}TRIGGER poison_history AFTER INSERT ON main.history
    BEGIN UPDATE items SET name=NULL WHERE id=NEW.row_id; END`);
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'trigger');
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('custom insert triggers and unrelated database triggers also fail closed', async () => {
  const db = await local();
  await db.run('CREATE TABLE peers(qty INTEGER)');
  await db.run('INSERT INTO peers VALUES (2)');
  await db.run('CREATE TRIGGER insert_side_effect AFTER INSERT ON items BEGIN UPDATE peers SET qty=9; END');
  await rejects(writeRow(db, 'items', { name: 'New' }, clock), 'trigger');
  expect(await db.all('SELECT * FROM items')).toEqual([]);
  expect(await db.all('SELECT * FROM peers')).toEqual([{ qty: 2 }]);
  await db.run('DROP TRIGGER insert_side_effect');
  await db.run('CREATE TRIGGER unrelated AFTER UPDATE ON peers BEGIN SELECT 1; END');
  await rejects(writeRow(db, 'items', { name: 'New' }, clock), 'trigger');
});

function timestampTrigger(table: string) {
  // The exact shipped Python _trigger_ddl, including its WHEN guard.
  return `CREATE TRIGGER ${qident(`${table}_updated_at`)} AFTER UPDATE ON ${qident(table)} FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE ${qident(table)} SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid;
END`;
}

test('canonical Python timestamp triggers remain usable and preserve explicit revisions and original history', async () => {
  const db = await local();
  await db.run(timestampTrigger('items'));
  await db.run(timestampTrigger('history'));
  const created = await writeRow(db, 'items', { name: 'Before' }, clock);
  const edited = await writeRow(db, 'items', { id: created.id, name: 'After' }, clock);
  expect(edited.updated_at).toBe('2026-01-02T00:00:00.001Z');
  expect(await db.all('SELECT * FROM items')).toEqual([edited]);
  expect(await db.all('SELECT col,old,new,updated_at FROM history')).toEqual([
    { col: 'name', old: 'Before', new: 'After', updated_at: edited.updated_at },
  ]);
  await db.run('ALTER TABLE items RENAME TO "order"');
  await db.run('DROP TRIGGER items_updated_at');
  await db.run(timestampTrigger('order'));
  await db.run("UPDATE catalog_properties SET tbl='order'");
  expect((await writeRow(db, 'order', { id: created.id, name: 'Keyword table' }, clock)).name).toBe('Keyword table');
});

for (const change of ['extra-statement', 'changed-guard', 'temporary']) test(`timestamp trigger allowlist checks the full definition (${change})`, async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before', qty: 2 }, clock);
  let sql = timestampTrigger('items');
  if (change === 'extra-statement') sql = sql.replace('\nEND', '\n    UPDATE items SET qty=9;\nEND');
  if (change === 'changed-guard') sql = sql.replace('WHEN NEW.updated_at = OLD.updated_at', 'WHEN 1');
  if (change === 'temporary') sql = sql.replace('CREATE TRIGGER', 'CREATE TEMP TRIGGER');
  await db.run(sql);
  const before = await db.all('SELECT * FROM items');
  await rejects(writeRow(db, 'items', { id: 'item-1', name: 'After' }, clock), 'trigger');
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test('creation overrides a migrated hub_at default while edits preserve existing hub arrivals', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Existing' }, clock);
  await db.run('ALTER TABLE items DROP COLUMN hub_at');
  await db.run("ALTER TABLE items ADD COLUMN hub_at TEXT DEFAULT '2026-01-01T00:00:00.000Z'");
  await db.run('ALTER TABLE history DROP COLUMN hub_at');
  await db.run("ALTER TABLE history ADD COLUMN hub_at TEXT DEFAULT '2026-01-01T00:00:00.000Z'");
  const created = await writeRow(db, 'items', { name: 'New' }, { ...clock, id: () => 'item-2' });
  expect(created.hub_at).toBeNull();
  expect(await db.all('SELECT hub_at FROM items WHERE id=?', ['item-2'])).toEqual([{ hub_at: null }]);
  const edited = await writeRow(db, 'items', { id: 'item-1', name: 'Edited' }, clock);
  expect(edited.hub_at).toBe(T0);
  expect(await db.all('SELECT col,hub_at FROM history')).toEqual([{ col: 'name', hub_at: null }]);
});

test('catalog system ownership blocks generic service tables on create, edit and restore', async () => {
  const db = await local();
  await writeRow(db, 'items', { name: 'Before' }, clock);
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY, kind TEXT, owner TEXT, deleted_at TEXT)');
  await db.run('INSERT INTO catalog_tables(id,kind,owner) VALUES (?,?,?)', ['items', 'system', 'fixture-service']);
  const before = await db.all('SELECT * FROM items');
  for (const patch of [{ name: 'New' }, { id: 'item-1', name: 'After' }, { id: 'item-1', deleted_at: null }]) {
    await rejects(writeRow(db, 'items', patch, { ...clock, id: () => 'item-2' }), 'read_only');
  }
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  await db.run("UPDATE catalog_tables SET kind='table'");
  expect((await writeRow(db, 'items', { id: 'item-1', name: 'Editable' }, clock)).name).toBe('Editable');
});

test('optimistic edits reject a stale form without losing newer cells or adding history', async () => {
  const db = await local();
  const selected = await writeRow(db, 'items', { name: 'Before', qty: 1 }, clock);
  const current = await writeRow(db, 'items', { id: selected.id, name: 'Other editor', qty: 2 }, {
    ...clock, expectedUpdatedAt: String(selected.updated_at),
  });
  const history = await db.all('SELECT * FROM history');
  const error = await rejects(writeRow(db, 'items', { id: selected.id, name: 'Stale form' }, {
    ...clock, expectedUpdatedAt: String(selected.updated_at),
  }), 'conflict', 'updated_at');
  expect(error.message).toContain('reload');
  expect(await db.all('SELECT * FROM items')).toEqual([current]);
  expect(await db.all('SELECT * FROM history')).toEqual(history);
  const rebased = await writeRow(db, 'items', { id: selected.id, name: 'Rebased form' }, {
    ...clock, expectedUpdatedAt: String(current.updated_at),
  });
  expect(rebased).toMatchObject({ name: 'Rebased form', qty: 2 });
  // Callers without an expected revision still merge into the current row.
  expect((await writeRow(db, 'items', { id: selected.id, name: 'Direct call' }, clock)).qty).toBe(2);
});

test('optimistic trash and restore use the same revision guard, with canonical edit-only options', async () => {
  const db = await local();
  const selected = await writeRow(db, 'items', { name: 'Before' }, clock);
  const deleted = await writeRow(db, 'items', { id: selected.id, deleted_at: true }, {
    ...clock, expectedUpdatedAt: String(selected.updated_at),
  });
  await rejects(writeRow(db, 'items', { id: selected.id, deleted_at: null }, {
    ...clock, expectedUpdatedAt: String(selected.updated_at),
  }), 'conflict');
  expect(await db.all('SELECT * FROM items')).toEqual([deleted]);
  expect((await writeRow(db, 'items', { id: selected.id, deleted_at: null }, {
    ...clock, expectedUpdatedAt: String(deleted.updated_at),
  })).deleted_at).toBeNull();
  await rejects(writeRow(db, 'items', { id: selected.id, name: 'Bad revision' }, {
    ...clock, expectedUpdatedAt: '2026-01-02T00:00:00Z',
  }), 'input');
  await rejects(writeRow(db, 'items', { name: 'New' }, {
    ...clock, id: () => 'item-2', expectedUpdatedAt: T1,
  }), 'input');
});

test('each successful UI write replaces only its row marker, including trash and restore', async () => {
  const db = await local();
  const first = await writeRow(db, 'items', { name: 'Before' }, clock);
  expect(await db.all("SELECT name FROM sqlite_master WHERE name='_core_pending'")).toEqual([{ name: '_core_pending' }]);
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: first.id, updated_at: T1 }]);
  for (const patch of [{ name: 'After' }, { deleted_at: true }, { deleted_at: null }]) {
    const row = await writeRow(db, 'items', { id: first.id, ...patch }, clock);
    expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: first.id, updated_at: row.updated_at }]);
  }
  const pending = await db.all('SELECT * FROM _core_pending');
  await rejects(writeRow(db, 'items', { id: first.id, name: null }, clock), 'required');
  await rejects(writeRow(db, 'items', { name: null }, { ...clock, id: () => 'invalid' }), 'required');
  expect(await db.all('SELECT * FROM _core_pending')).toEqual(pending);
});

test('a pending-marker storage failure rolls back the row and its cell history', async () => {
  const db = await local();
  await db.run("CREATE TABLE _core_pending (tbl TEXT, row_id TEXT, updated_at TEXT CHECK(updated_at='2026-01-02T00:00:00.000Z'), PRIMARY KEY(tbl,row_id))");
  const before = await writeRow(db, 'items', { name: 'Before' }, clock);
  await rejects(writeRow(db, 'items', { id: before.id, name: 'After' }, clock), 'storage');
  expect(await db.all('SELECT * FROM items')).toEqual([before]);
  expect(await db.all('SELECT * FROM history')).toEqual([]);
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: before.id, updated_at: T1 }]);
});
