import type { Catalog, DeleteViewArgs, ListViewsArgs, SaveViewArgs, SavedViewDefinition, SavedViewList, SavedViewRecord, View } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { readCatalog } from './catalog.ts';
import { qident, type Row } from './validate.ts';
import { compileView, validateView } from './view.ts';
import { writeRow } from './write.ts';
import storage from '../schema/saved-views.json';

// Recognition only. Ordinary replicas receive these statements via logged DDL;
// core never creates, adopts or repairs a table named views.
const normalizeDDL = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const matchesMetadata = (row: Row | undefined, expected: object) =>
  row !== undefined && Object.entries(expected).every(([key, value]) => row[key] === value);

async function storageProblem(db: SqlDriver, catalog: Catalog): Promise<string | null> {
  const schema = await db.all("SELECT name,sql FROM main.sqlite_master WHERE (type='table' AND name='views') OR (type='trigger' AND name='views_updated_at') ORDER BY type");
  if (!schema.length) return 'Saved views need operator provisioning; sync the views schema and catalog first.';
  const entry = catalog.tables.find(t => t.id === storage.table.id);
  const props = catalog.properties.filter(p => p.tbl === storage.table.id);
  if (schema.length !== storage.ddl.length || schema.some((s, i) => normalizeDDL(s.sql) !== normalizeDDL(storage.ddl[i]))
    || !matchesMetadata(entry, storage.table) || props.length !== storage.properties.length
    || storage.properties.some(({ sort: _sort, ...identity }) =>
      // Sort is a seed default; users can change presentation order.
      !matchesMetadata(props.find(p => p.id === identity.id), identity))) {
    return 'Saved-view schema or marker does not match saved-views/v1; operator review is required.';
  }
  return null;
}

function object(value: unknown, keys?: string[]): asserts value is Row {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || (keys && Object.keys(value).some(k => !keys.includes(k)))) throw new Error('Invalid saved-view object.');
}

/** Copy plain finite JSON data before the first await, without invoking getters. */
function snapshot<T>(value: T): T {
  const seen = new Set<object>();
  function copy(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    if (!v || typeof v !== 'object' || seen.has(v)) throw new Error('Saved views require finite JSON data.');
    if (!Array.isArray(v)) object(v);
    seen.add(v);
    const out: Row | unknown[] = Array.isArray(v) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Saved views require plain JSON data.');
      // Optional argument fields may be undefined, as in ordinary TS callers.
      if (descriptor.value !== undefined) (out as Row)[key] = copy(descriptor.value);
    }
    seen.delete(v);
    return out;
  }
  return copy(value) as T;
}

class UnavailableView extends Error {}

async function definitionView(db: SqlDriver, catalog: Catalog, table: string, value: unknown): Promise<View> {
  let view: View;
  let referenced: string[];
  try {
    object(value);
    if (value.version !== 1 && value.version !== 2) throw new Error('Unsupported saved-view definition version.');
    object(value, ['version', 'columns', 'filters', 'sort', 'search', 'trash', 'widths', ...(value.version===2?['groups','timeZone']:[])]);
    if (!catalog.tables.some(t => t.id === table)) throw new Error('Saved-view target is absent from the catalog.');
    const { version, widths, timeZone, ...query } = value;
    view = { table, ...query } as View;
    validateView(view, catalog.properties);
    const filters=[...(view.filters ?? []),...(view.groups ?? []).flatMap(g=>g.filters)];
    if (version===1 && (filters.some(f=>f.relative!==undefined) || view.sort?.some(s=>s.mode!==undefined))) throw new Error('View extensions require version 2.');
    if (timeZone!==undefined && (typeof timeZone!=='string' || timeZone.length>100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timeZone))) throw new Error('Invalid saved-view timezone.');
    if (filters.some(f=>f.relative!==undefined) && timeZone===undefined) throw new Error('Relative saved views require a timezone.');
    if (view.columns && new Set(view.columns).size !== view.columns.length) throw new Error('Duplicate saved-view columns.');
    referenced = [...(view.columns ?? []), ...filters.map(f => f.column), ...(view.sort ?? []).map(s => s.column)];
    if (widths !== undefined) {
      object(widths);
      for (const [column, width] of Object.entries(widths)) {
        if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) throw new Error('Invalid saved-view column width.');
        compileView({ table, columns: [column] }, catalog.properties);
        referenced.push(column);
      }
    }
  } catch (error) {
    throw new UnavailableView(error instanceof Error ? error.message : 'Invalid saved-view definition.');
  }
  // Keep driver errors outside the validation catch. No partial list or write
  // succeeds after a failed schema read.
  const physical = new Set((await db.all(`PRAGMA main.table_info(${qident(table)})`)).map(c => c.name));
  if (!physical.has('id') || !physical.has('deleted_at')) throw new UnavailableView('Saved-view target schema is unavailable.');
  if (referenced.some(c => !physical.has(c))) throw new UnavailableView('Saved-view column is absent from the local schema.');
  return view;
}

async function record(db: SqlDriver, catalog: Catalog, row: Row): Promise<SavedViewRecord> {
  const result: SavedViewRecord = {
    id: String(row.id), name: typeof row.name === 'string' ? row.name : String(row.id), tbl: String(row.tbl),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    definition: null, view: null, unavailable: null,
  };
  let definition: unknown;
  try { definition = JSON.parse(String(row.definition)); }
  catch { result.unavailable = 'Saved-view definition is not valid JSON.'; return result; }
  // Only definition/schema validation is per-view. Driver failures must abort
  // the whole operation, especially after a write inside its transaction.
  try {
    result.view = await definitionView(db, catalog, result.tbl, definition);
    result.definition = definition as SavedViewDefinition;
  } catch (error) {
    if (!(error instanceof UnavailableView)) throw error;
    result.unavailable = error.message;
  }
  return result;
}

/** Lists shared definitions only. Returned view.columns is SQL projection and
 * may omit id, updated_at and hidden fields. For editing, query without columns
 * or fetch a full row by id; never treat a projected row as a complete record. */
export async function listViews(db: SqlDriver, args: ListViewsArgs): Promise<SavedViewList> {
  args = snapshot(args);
  object(args, ['table', 'trash']);
  if (typeof args.table !== 'string' || (args.trash !== undefined && typeof args.trash !== 'boolean')) throw new Error('Invalid saved-view list arguments.');
  qident(args.table);
  return db.transaction(async () => {
    const catalog = await readCatalog(db);
    const unavailable = await storageProblem(db, catalog);
    if (unavailable) return { views: [], unavailable };
    const rows = await db.all(`SELECT * FROM main.views WHERE tbl=? AND deleted_at IS ${args.trash ? 'NOT ' : ''}NULL ORDER BY name,id`, [args.table]);
    const views: SavedViewRecord[] = [];
    for (const row of rows) views.push(await record(db, catalog, row));
    return { views, unavailable: null };
  });
}

// writeRow retains every guard/history/outbox step under our existing writer
// reservation. Only its inner transaction wrapper is elided, never the outer.
function inTransaction(db: SqlDriver): SqlDriver {
  return { all: db.all.bind(db), run: db.run.bind(db), transaction: body => body() };
}

export async function saveView(db: SqlDriver, args: SaveViewArgs, options: { origin?: string } = {}): Promise<SavedViewRecord> {
  args = snapshot(args); options = snapshot(options);
  object(args, ['table', 'name', 'definition', 'id', 'expectedUpdatedAt']);
  if (typeof args.table !== 'string' || typeof args.name !== 'string' || !args.name.trim()) throw new Error('Invalid saved-view name or table.');
  if (args.id !== undefined && args.expectedUpdatedAt === undefined) throw new Error('Editing a saved view requires expectedUpdatedAt.');
  return db.transaction(async () => {
    const catalog = await readCatalog(db);
    const problem = await storageProblem(db, catalog);
    if (problem) throw new Error(problem);
    await definitionView(db, catalog, args.table, args.definition);
    const row = await writeRow(inTransaction(db), 'views', {
      ...(args.id === undefined ? {} : { id: args.id }), name: args.name, tbl: args.table, definition: args.definition,
    }, { ...options, expectedUpdatedAt: args.expectedUpdatedAt });
    return record(db, catalog, row);
  });
}

/** Tombstone through writeRow without requiring a readable definition. */
export async function deleteView(db: SqlDriver, args: DeleteViewArgs, options: { origin?: string } = {}): Promise<SavedViewRecord> {
  args = snapshot(args); options = snapshot(options);
  object(args, ['id', 'expectedUpdatedAt']);
  if (typeof args.id !== 'string' || !args.id) throw new Error('Invalid saved-view id.');
  if (args.expectedUpdatedAt === undefined) throw new Error('Deleting a saved view requires expectedUpdatedAt.');
  return db.transaction(async () => {
    const catalog = await readCatalog(db);
    const problem = await storageProblem(db, catalog);
    if (problem) throw new Error(problem);
    const row = await writeRow(inTransaction(db), 'views', { id: args.id, deleted_at: true }, { ...options, expectedUpdatedAt: args.expectedUpdatedAt });
    return record(db, catalog, row);
  });
}
