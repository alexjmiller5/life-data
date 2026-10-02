import type { SqlDriver, Value } from './driver.ts';
import { decodeProperty } from './catalog.ts';
import { initCore } from './sync.ts';
import { asList, empty, qident, validEditTimestamp, validateRow, type Property, type Row, type Violation } from './validate.ts';

export type WriteViolation = Violation & { tbl: string; row_id: string | null };
export class ValidationError extends Error {
  constructor(public readonly violations: WriteViolation[]) {
    super(violations.map(v => `${v.tbl}[${v.row_id ?? ''}].${v.col}: ${v.message}`).join('\n'));
    this.name = 'ValidationError';
  }
}

const systemColumns = new Set(['id', 'created_at', 'updated_at', 'hub_at', 'deleted_at']);
const plain = (v: unknown): v is Row => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** UI and write boundary share this contract: service-owned tables carry
 * catalog_tables.kind='system'. Free-form owner text is not a permission. */
export function isReadOnlyTable(table: string, catalogEntry?: Row): boolean {
  return /^(catalog_|sqlite_|_)/i.test(table) || /^(history|provenance)$/i.test(table)
    || String(catalogEntry?.kind ?? '').trim().toLowerCase() === 'system';
}

/** Missing id creates; supplied id edits an existing row (never upserts).
 * deleted_at:true requests deletion at the new revision; null restores.
 * now/id are host/test seams; id generates row IDs only. History IDs always
 * come from SQLite. No caller may supply created_at, updated_at or hub_at.
 * Enforced invariants require the CLI's estate-wide snapshot write path.
 * Custom triggers anywhere in main/temp block writes. Only the exact main
 * timestamp trigger shipped by Python is supported; this writer keeps it idle.
 * Forms should pass expectedUpdatedAt from their selected row. A stale edit
 * fails with rule='conflict'; omit it for unconditional merges into current data.
 */
export async function writeRow(
  db: SqlDriver, table: string, patch: Row,
  options: { now?: () => Date; id?: () => string; origin?: string; expectedUpdatedAt?: string } = {},
): Promise<Row> {
  let rowId: string | null = null;
  const fail = (col: string, rule: string, message: string): never => {
    throw new ValidationError([{ tbl: table, row_id: rowId, col, rule, message }]);
  };
  const quote = (name: string): string => {
    try { return qident(name); } catch { return fail(name, 'identifier', 'Invalid SQL identifier.'); }
  };
  try {
    if (typeof table !== 'string') fail('', 'input', 'table must be a string.');
    const target = `main.${quote(table)}`;
    if (isReadOnlyTable(table)) {
      fail('', 'read_only', 'System tables are read-only through writeRow.');
    }
    if (!plain(patch) || Reflect.ownKeys(patch).some(k => typeof k !== 'string'
      || !Object.getOwnPropertyDescriptor(patch, k)?.enumerable
      || !('value' in Object.getOwnPropertyDescriptor(patch, k)!))) {
      fail('', 'input', 'patch must be a plain data object.');
    }
    // Snapshot the caller's data before the first await.
    patch = { ...patch };
    if (!plain(options) || Object.keys(options).some(k => !['now', 'id', 'origin', 'expectedUpdatedAt'].includes(k))
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.id !== undefined && typeof options.id !== 'function')
      || (options.expectedUpdatedAt !== undefined && !validEditTimestamp(options.expectedUpdatedAt))
      || (options.origin !== undefined && (typeof options.origin !== 'string' || !options.origin.trim()))) {
      fail('', 'input', 'Invalid write options.');
    }
    const { now = () => new Date(), id: makeId, origin = 'local', expectedUpdatedAt } = options;
    const editing = Object.hasOwn(patch, 'id');
    if (!editing && expectedUpdatedAt !== undefined) fail('updated_at', 'input', 'expectedUpdatedAt is only valid for edits.');
    if (editing) {
      if (typeof patch.id !== 'string' || !patch.id) fail('id', 'input', 'id must be a nonempty string.');
      rowId = patch.id as string;
    }
    return await db.transaction(async () => {
      const exists = async (name: string) => (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?", [name])).length > 0;
      for (const name of [table, 'catalog_properties', 'catalog_rules', 'history']) {
        if (!await exists(name)) fail('', 'schema', `Missing ${name} in this replica; sync its schema before writing.`);
      }
      if (await exists('catalog_tables')) {
        const entry = (await db.all('SELECT * FROM main.catalog_tables WHERE id=? AND deleted_at IS NULL', [table]))[0];
        if (isReadOnlyTable(table, entry)) fail('', 'read_only', 'Catalog system tables are read-only through writeRow.');
      }
      // ponytail: no complete trigger journal yet. Inspect the whole database,
      // including history and TEMP triggers, before any mutation. Names alone
      // cannot prove safety; only Python's exact, dormant timestamp DDL can.
      const triggers = await db.all("SELECT name,tbl_name,sql,0 AS temporary FROM main.sqlite_master WHERE type='trigger' UNION ALL SELECT name,tbl_name,sql,1 AS temporary FROM temp.sqlite_master WHERE type='trigger'");
      for (const trigger of triggers) {
        const t = String(trigger.tbl_name);
        const canonical = `CREATE TRIGGER ${quote(`${t}_updated_at`)} AFTER UPDATE ON ${quote(t)} FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE ${quote(t)} SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid; END`;
        if (trigger.temporary || String(trigger.sql).replace(/\s+/g, ' ').trim() !== canonical) {
          fail('', 'trigger', `Unsupported trigger ${trigger.name} on ${t}; this database needs a writer that validates and journals all trigger effects before writeRow can edit it.`);
        }
      }
      const cols = (await db.all(`PRAGMA main.table_info(${quote(table)})`)).map(r => String(r.name));
      for (const col of cols) quote(col);
      if (['id', 'created_at', 'updated_at', 'deleted_at'].some(c => !cols.includes(c))) {
        fail('', 'schema', 'Table lacks the sync columns required by writeRow.');
      }
      const props = (await db.all('SELECT * FROM main.catalog_properties WHERE tbl=? AND deleted_at IS NULL ORDER BY sort,col', [table])).map(row => {
        try { return decodeProperty(row); }
        catch { return fail(String(row.col ?? ''), 'catalog', 'Invalid catalog property; repair options/inputs before writing.'); }
      });
      if (!props.length) fail('', 'catalog', 'Table has no active catalog properties; sync or catalog it before writing.');
      for (const p of props) {
        if (typeof p.col !== 'string' || !cols.includes(p.col)) fail('', 'catalog', 'Catalog column is absent from the local schema; sync before writing.');
        if ((p.options != null && (!Array.isArray(p.options) || p.options.some(o => !plain(o) || typeof o.v !== 'string')))
          || (p.inputs != null && (!Array.isArray(p.inputs) || p.inputs.some(i => typeof i !== 'string')))) {
          fail(p.col, 'catalog', 'Invalid catalog options or inputs.');
        }
      }
      // ponytail: enforced invariants need estate snapshots; use the CLI until
      // before/changed/now can cover trigger-driven changes and cross-table reads.
      const rules = await db.all("SELECT * FROM main.catalog_rules WHERE kind='invariant' AND enforce != 0 AND deleted_at IS NULL");
      for (const rule of rules) {
        if (rule.tbl === table || rule.scope === 'estate') {
          fail(String(rule.col ?? ''), 'invariant', `Enforced invariant ${rule.id} requires the CLI write path; use the CLI until local invariant execution is supported.`);
        }
      }
      const byCol = new Map(props.map(p => [p.col, p]));
      const values: Record<string, Value> = Object.create(null);
      const encode = (col: string, value: unknown): Value => {
        const type = byCol.get(col)?.type;
        if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
        if (typeof value === 'boolean' && type === 'bool') return Number(value);
        if (['json', 'multi_select', 'multi_ref'].includes(type ?? '') && (Array.isArray(value) || (type === 'json' && plain(value)))) {
          try {
            return JSON.stringify(value, (_key, v) => {
              if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint'
                || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('Not JSON data');
              return v;
            });
          } catch { fail(col, 'input', 'Value must contain only finite JSON data.'); }
        }
        return fail(col, 'input', 'Value must be a supported finite scalar or cataloged JSON value.');
      };
      for (const [col, value] of Object.entries(patch)) {
        quote(col);
        if (col === 'id') continue;
        if (['created_at', 'updated_at', 'hub_at'].includes(col)) fail(col, 'read_only', `${col} is managed by the write path.`);
        if (!cols.includes(col) || (!systemColumns.has(col) && !byCol.has(col))) fail(col, 'column', 'Unknown or uncataloged column.');
        if (col === 'deleted_at') {
          if (value !== true && value !== null) fail(col, 'input', 'Use deleted_at:true to delete or null to restore.');
        } else values[col] = encode(col, value);
      }
      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()) || !validEditTimestamp(instant.toISOString())) {
        fail('updated_at', 'clock', 'Device time must be a valid UTC millisecond timestamp.');
      }
      const before = editing ? (await db.all(`SELECT * FROM ${target} WHERE id=?`, [rowId]))[0] ?? null : null;
      if (editing && !before) fail('id', 'not_found', 'Row is absent from this replica; sync before editing. Omit id to create.');
      if (before && expectedUpdatedAt !== undefined && before.updated_at !== expectedUpdatedAt) {
        fail('updated_at', 'conflict', 'Row changed since it was selected; reload it and review your edit before retrying.');
      }
      if (before && (!validEditTimestamp(before.updated_at) || Date.parse(String(before.updated_at)) - instant.getTime() > 300_000)) {
        fail('updated_at', 'clock', 'Stored revision is invalid or over five minutes ahead; sync and check device time.');
      }
      const stamp = new Date(before ? Math.max(instant.getTime(), Date.parse(String(before.updated_at)) + 1) : instant.getTime()).toISOString();
      if (!validEditTimestamp(stamp)) fail('updated_at', 'clock', 'Next revision is outside the supported timestamp range.');
      if (!editing) {
        rowId = makeId ? makeId() : (await db.all('SELECT lower(hex(randomblob(16))) AS id'))[0]!.id as string;
        if (typeof rowId !== 'string' || !rowId) fail('id', 'input', 'Generated id must be a nonempty string.');
        for (const p of props) {
          if (systemColumns.has(p.col) || Object.hasOwn(patch, p.col) || p.default_value == null) continue;
          if (typeof p.default_value !== 'string') fail(p.col, 'catalog', 'Catalog defaults must be strings.');
          const value = p.default_value.startsWith('sql:')
            ? (await db.all(`SELECT (${p.default_value.slice(4)}) AS value`))[0]!.value : p.default_value;
          values[p.col] = encode(p.col, value);
        }
        values.id = rowId;
        values.created_at = stamp;
        if (cols.includes('hub_at')) values.hub_at = null;
      }
      values.updated_at = stamp;
      if (Object.hasOwn(patch, 'deleted_at')) values.deleted_at = patch.deleted_at === true ? stamp : null;
      if (before) {
        // Preserve SQLite storage classes/precision for cell comparisons and casts.
        await db.run(`CREATE TEMP TABLE temp._core_write_before AS SELECT * FROM ${target} WHERE id=?`, [rowId]);
        const keys = Object.keys(values);
        await db.run(`UPDATE ${target} SET ${keys.map(c => `${quote(c)}=?`).join(',')} WHERE id=?`, [...keys.map(c => values[c]!), rowId]);
      } else {
        const keys = Object.keys(values);
        await db.run(`INSERT INTO ${target} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(c => values[c]!));
      }
      const after = (await db.all(`SELECT * FROM ${target} WHERE id=?`, [rowId]))[0];
      if (!after || after.id !== rowId || after.updated_at !== stamp
        || after.created_at !== (before ? before.created_at : stamp)
        || after.deleted_at !== (Object.hasOwn(patch, 'deleted_at') ? values.deleted_at : before?.deleted_at ?? null)
        || (!before && cols.includes('hub_at') && after.hub_at !== null)
        || (before && after.hub_at !== before.hub_at)) {
        fail('', 'storage', 'Stored identity or system timestamps changed unexpectedly; transaction rolled back.');
      }
      if (!after.deleted_at) {
        const references = new Map<string, Set<unknown>>();
        const extra = new Map<Property, string[]>();
        for (const p of props) {
          if (empty(after[p.col])) continue;
          if (p.options_sql) {
            extra.set(p, (await db.all(`SELECT * FROM (${p.options_sql})`)).map(r => Object.values(r)[0] as string));
          }
          if (!['ref', 'multi_ref'].includes(p.type ?? '')) continue;
          if (!p.ref_table) fail(p.col, 'catalog', 'Reference property has no ref_table; repair the catalog.');
          const refTable = quote(p.ref_table!);
          if (!await exists(p.ref_table!)) fail(p.col, 'ref', `Reference table ${p.ref_table} is absent from this replica; sync it before writing.`);
          const refCols = (await db.all(`PRAGMA main.table_info(${refTable})`)).map(r => r.name);
          if (!refCols.includes('id') || !refCols.includes('deleted_at')) fail(p.col, 'ref', 'Reference schema is incomplete in this replica; sync it before writing.');
          const found = references.get(p.ref_table!) ?? new Set();
          for (const value of p.type === 'multi_ref' ? asList(after[p.col]) ?? [] : [after[p.col]]) {
            if (typeof value !== 'string' && typeof value !== 'number') continue;
            if ((await db.all(`SELECT 1 FROM main.${refTable} WHERE id=? AND deleted_at IS NULL`, [value])).length) found.add(value);
          }
          references.set(p.ref_table!, found);
        }
        const violations = validateRow(props, before, after, {
          refOk: (t, id) => references.get(t)?.has(id) ?? false,
          extraOptions: p => extra.get(p) ?? [],
        }).map(v => ({ ...v, tbl: table, row_id: rowId,
          message: v.rule === 'ref' ? 'Reference is not live in the local replica; sync the reference table and retry (it may be incomplete).' : v.message }));
        if (violations.length) throw new ValidationError(violations);
      }
      if (before) {
        const historyHasHubAt = (await db.all('PRAGMA main.table_info(history)')).some(c => c.name === 'hub_at');
        for (const col of cols.filter(c => !['updated_at', 'hub_at'].includes(c))) {
          const c = quote(col);
          await db.run(`INSERT INTO main.history (id,tbl,row_id,col,old,new,origin,created_at,updated_at${historyHasHubAt ? ',hub_at' : ''})
            SELECT lower(hex(randomblob(16))),?,a.id,?,CAST(b.${c} AS TEXT),CAST(a.${c} AS TEXT),?,?,?${historyHasHubAt ? ',?' : ''}
            FROM ${target} AS a JOIN temp._core_write_before AS b ON a.id=b.id WHERE b.${c} IS NOT a.${c}`,
          [table, col, origin, stamp, stamp, ...(historyHasHubAt ? [null] : [])]);
        }
        await db.run('DROP TABLE temp._core_write_before');
      }
      await initCore(db);
      await db.run('INSERT OR REPLACE INTO _core_pending(tbl,row_id,updated_at) VALUES (?,?,?)', [table, rowId, stamp]);
      return after;
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // SQL constraints, malformed catalog SQL and driver failures all abort the
    // transaction. Keep the structured boundary without leaking row values.
    throw new ValidationError([{ tbl: table, row_id: rowId, col: '', rule: 'storage', message: 'Local write failed; transaction rolled back. Check the schema, catalog SQL and database constraints.' }]);
  }
}
