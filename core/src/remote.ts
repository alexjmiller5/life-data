import type { Hub, SqlDriver } from './driver.ts';
import type { RemoteRecord, RemoteRowArgs, RemoteRowResult, RemoteRowsArgs, RemoteRowsPage } from './contract.generated.ts';
import { qident, validEditTimestamp, type Row } from './validate.ts';
import { displayName } from './view.ts';

type PageArgs = Omit<RemoteRowsArgs, 'endpoint'>;
type RowArgs = Omit<RemoteRowArgs, 'endpoint'>;
type Shape = { columns: string[]; display: string | undefined; signature: string };
const plain = (value: unknown): value is Row => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
class RemoteReadError extends Error {}
function fail(message: string): never { throw new RemoteReadError(message); }
function input(value: unknown, keys: string[]): asserts value is Row {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid remote read request');
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && !/^sqlite_/i.test(value);

/** Metadata only. Always use main: TEMP objects cannot supply bindings or table
 * identity. Hosts serialize this connection; each metadata check is a short
 * transaction, released before HTTP. No initCore, DDL or row staging. */
async function shape(db: SqlDriver, endpoint: string, table: string): Promise<Shape> {
  const schema = await db.all("SELECT type,name,sql FROM main.sqlite_master ORDER BY type,name");
  const exists = (name: string) => schema.some(row => row.type === 'table' && row.name === name);
  const bindings: unknown[] = [];
  for (const [name, key] of [['_core_state', 'hub'], ['_sync_state', 'hub_url']]) {
    if (!exists(name)) continue;
    const rows = await db.all(`SELECT value FROM main.${qident(name)} WHERE key=?`, [key]);
    for (const row of rows) bindings.push(row.value);
  }
  if (!endpoint || !bindings.length || bindings.some(value => value !== endpoint)) fail('replica is not bound to this hub');
  const physical = schema.find(row => row.type === 'table' && row.name === table);
  if (!physical || typeof physical.sql !== 'string' || /^CREATE VIRTUAL TABLE/i.test(physical.sql) || !exists('catalog_tables')) {
    fail('remote table schema is unavailable; sync first');
  }
  const entries = await db.all('SELECT * FROM main.catalog_tables WHERE id=? AND deleted_at IS NULL', [table]);
  if (entries.length !== 1) fail('remote table is not in the catalog');
  const fields = await db.all(`PRAGMA main.table_xinfo(${qident(table)})`);
  const id = fields.find(field => field.name === 'id');
  if (!id || id.pk !== 1 || String(id.type).trim().toUpperCase() !== 'TEXT' || fields.filter(field => field.pk).length !== 1
    || !['updated_at', 'deleted_at'].every(name => fields.some(field => field.name === name))
    || fields.some(field => typeof field.name !== 'string' || field.hidden === 1)) fail('remote table has unsupported sync columns');
  const columns = fields.map(field => { qident(String(field.name)); return String(field.name); });
  const display = typeof entries[0].display === 'string' && columns.includes(entries[0].display) ? entries[0].display : undefined;
  const log = exists('_schema_log') ? (await db.all('SELECT count(*) AS count,coalesce(max(id),0) AS last FROM main._schema_log'))[0] : undefined;
  // Ordered tuples survive native drivers reconstructing object keys. Log
  // identity invalidates a logged drop/recreate with identical physical SQL.
  return { columns, display, signature: JSON.stringify([physical.sql,
    fields.map(field => [field.cid,field.name,field.type,field.notnull,field.dflt_value,field.pk,field.hidden]),
    entries[0].display ?? null, log ? [log.count,log.last] : null, bindings]) };
}

async function metadata<T>(db: SqlDriver, body: () => Promise<T>): Promise<T> {
  try { return await db.transaction(body); }
  catch (error) {
    if (error instanceof RemoteReadError) throw error;
    // Driver diagnostics can contain private schema/SQL or file paths.
    throw new Error('remote table schema is unavailable; sync first');
  }
}

function cursorAfter(cursor: unknown, endpoint: string, table: string, signature: string): string | undefined {
  if (cursor === undefined) return;
  let value: unknown;
  try { if (typeof cursor !== 'string' || !cursor || cursor.length > 1_048_576) throw new Error(); value = JSON.parse(cursor); }
  catch { fail('invalid remote cursor; refresh this table'); }
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[1] !== endpoint || value[2] !== table
    || value[3] !== signature || typeof value[4] !== 'string' || !value[4]) fail('invalid remote cursor; refresh this table');
  return value[4];
}

function receipt(data: unknown, columns: string[], limit: number): Row[] {
  const invalid = () => fail('invalid hub row response');
  if (!plain(data) || !Array.isArray(data.rows) || data.rows.length > limit || !Object.hasOwn(data, 'next_cursor')) invalid();
  const page = data as { rows: unknown[]; next_cursor: unknown };
  for (const row of page.rows) {
    if (!plain(row) || Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row, column))
      || Object.values(row).some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
      || typeof row.id !== 'string' || !row.id || !validEditTimestamp(row.updated_at)
      || (row.deleted_at !== null && !validEditTimestamp(row.deleted_at))) invalid();
  }
  const rows = page.rows as Row[];
  const expected = rows.length === limit ? rows.at(-1)!.id : null;
  if (page.next_cursor !== expected) invalid();
  return rows;
}

async function read(db: SqlDriver, hub: Hub, table: string, limit: number, cursor?: string, id?: string): Promise<RemoteRowsPage> {
  if (!identifier(table)) fail('invalid remote table');
  const endpoint = hub.endpoint;
  const before = await metadata(db, () => shape(db, endpoint, table));
  const after = cursorAfter(cursor, endpoint, table, before.signature);
  const body: Row = { table, since: '', columns: before.columns, limit,
    ...(after === undefined ? {} : { after }), ...(id === undefined ? {} : { where: { id } }) };
  const { data } = await hub.post('/v1/rows/pull', body);
  return metadata(db, async () => {
    let current: Shape;
    try { current = await shape(db, endpoint, table); }
    catch { fail('replica schema or hub binding changed during remote read'); }
    if (hub.endpoint !== endpoint || current.signature !== before.signature) fail('replica schema or hub binding changed during remote read');
    const rows = receipt(data, before.columns, limit);
    const ids = rows.map(row => row.id as string);
    const sequence = after === undefined ? ids : [after, ...ids];
    if (sequence.length > 1) {
      // SQLite applies the left SELECT's ID collation to UNION/ORDER BY. The
      // WHERE 0 branch supplies metadata only, never scans local table rows.
      // This checks order, collation-equivalent duplicates and cursor progress
      // using only the bounded response. No SQL parser or host collation API.
      const ordered = await db.all(`SELECT id FROM main.${qident(table)} WHERE 0 UNION SELECT CAST(value AS TEXT) FROM json_each(?) ORDER BY id`, [JSON.stringify(sequence)]);
      if (ordered.length !== sequence.length || ordered.some((row, index) => row.id !== sequence[index])) fail('invalid hub row response');
    }
    if (id !== undefined) {
      if (rows.length > 1) fail('invalid hub row response');
      if (rows.length && (await db.all(`SELECT id FROM main.${qident(table)} WHERE 0 UNION SELECT ? EXCEPT SELECT ?`, [ids[0], id])).length) fail('invalid hub row response');
    }
    const nextCursor = rows.length === limit ? JSON.stringify([1, endpoint, table, before.signature, ids.at(-1)]) : null;
    if (nextCursor && nextCursor.length > 1_048_576) fail('remote cursor exceeds supported size');
    return { rows: rows.map(record => ({ record: { ...record }, label: displayName(record, before.display), deleted: record.deleted_at !== null } satisfies RemoteRecord)), nextCursor };
  });
}

/** One online page. Never merges records into the replica or grants coverage.
 * Clients deduplicate repeated IDs across pages on a changing hub before keyed
 * rendering; replacing earlier displayed rows does not establish a snapshot. */
export async function readRemoteRows(db: SqlDriver, hub: Hub, args: PageArgs): Promise<RemoteRowsPage> {
  input(args, ['table', 'limit', 'cursor']);
  const limit = args.limit === undefined ? 50 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('remote limit must be an integer from 1 to 200');
  return read(db, hub, args.table, limit, args.cursor);
}

/** One ID lookup under SQLite column equality. The returned identity may differ
 * in spelling under NOCASE/RTRIM; tombstones remain explicit and read-only. */
export async function readRemoteRow(db: SqlDriver, hub: Hub, args: RowArgs): Promise<RemoteRowResult> {
  input(args, ['table', 'id']);
  if (typeof args.id !== 'string' || !args.id) fail('invalid remote row ID');
  const page = await read(db, hub, args.table, 2, undefined, args.id);
  return { row: page.rows[0] ?? null };
}
