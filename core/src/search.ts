import type { Catalog, SearchArgs, SearchHit } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { readCatalog } from './catalog.ts';
import { qident, type Row } from './validate.ts';
import { displayName } from './view.ts';

export const SEARCH_TEXT_TYPES = new Set(['text', 'markdown', 'select', 'url', 'email', 'phone', 'ref', 'date', 'datetime']);

/** FTS syntax is never user syntax. All words are literal prefixes, ANDed.
 * Unicode letters/numbers/marks work in JSC without Intl or a platform parser. */
export function compileSearch(text: string): string | null {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid search text (maximum 4096 characters).');
  const terms = text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  if (terms.length > 64) throw new Error('Invalid search text (maximum 64 words).');
  return terms.length ? terms.map(term => `"${term}"*`).join(' AND ') : null;
}

/** Queue-only triggers deliberately require no FTS module in other writers.
 * UPSERT avoids an outer OR ABORT/IGNORE/REPLACE overriding conflict handling. */
export function searchTriggers(table: string, target = table): { name: string; sql: string }[] {
  const literal = `'${table.replace(/'/g, "''")}'`;
  return ['insert', 'update', 'delete'].map(event => {
    const name = `_core_search_${table}_${event}`;
    const rows = event === 'update' ? ['OLD', 'NEW'] : [event === 'delete' ? 'OLD' : 'NEW'];
    const enqueue = rows.map(row => `INSERT INTO _core_search_dirty(tbl,row_id) SELECT ${literal},${row}.id WHERE typeof(${row}.id)='text' AND ${row}.id<>'' ON CONFLICT(tbl,row_id) DO NOTHING;`).join(' ');
    return { name, sql: `CREATE TRIGGER ${qident(name)} AFTER ${event.toUpperCase()} ON ${qident(target)} BEGIN ${enqueue} END` };
  });
}

export function isSearchTrigger(trigger: Row): boolean {
  if (trigger.temporary || typeof trigger.tbl_name !== 'string') return false;
  // ALTER TABLE RENAME rewrites ON but leaves the trigger name and queue
  // literal unchanged. Recognize that exact harmless form for reconciliation.
  const owner = /^_core_search_(.+)_(insert|update|delete)$/.exec(String(trigger.name))?.[1];
  if (!owner) return false;
  try { return searchTriggers(owner, trigger.tbl_name).some(t => t.name === trigger.name && t.sql === trigger.sql); }
  catch { return false; }
}

async function initSearch(db: SqlDriver) {
  const names = new Set((await db.all("SELECT name FROM main.sqlite_master WHERE type='table' AND name GLOB '_core_search_*'")).map(r => r.name));
  const complete = ['_core_search_fts', '_core_search_docs', '_core_search_dirty', '_core_search_state'].every(name => names.has(name));
  try {
    await db.run("CREATE VIRTUAL TABLE IF NOT EXISTS _core_search_fts USING fts5(body, tokenize='unicode61')");
  } catch (error) {
    if (/no such module: fts5|no such tokenizer: unicode61/i.test(String(error))) {
      throw new Error('Search requires SQLite FTS5 with the unicode61 tokenizer. Use an FTS5-enabled SQLite build; search has no scan fallback.');
    }
    throw error;
  }
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_docs (docid INTEGER PRIMARY KEY, tbl TEXT NOT NULL, row_id TEXT NOT NULL, label TEXT NOT NULL, trashed INTEGER NOT NULL, UNIQUE(tbl,row_id))');
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_dirty (tbl TEXT NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY(tbl,row_id))');
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_state (tbl TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)');
  if (!complete) {
    // These four tables form one disposable cache. Recreating just one would
    // leave apparently current fingerprints beside an empty or stale index.
    await db.run('DELETE FROM _core_search_fts');
    await db.run('DELETE FROM _core_search_docs');
    await db.run('DELETE FROM _core_search_dirty');
    await db.run('DELETE FROM _core_search_state');
  }
}

type IndexedTable = { table: string; columns: string[]; display?: string; fingerprint: string; sweep: boolean };
async function indexedTables(db: SqlDriver, catalog: Catalog, schema: Row[]): Promise<IndexedTable[]> {
  const result: IndexedTable[] = [];
  for (const entry of catalog.tables) {
    const table = String(entry.id);
    if (/^(_|sqlite_)/i.test(table)) continue;
    const physical = schema.find(r => r.type === 'table' && r.name === table);
    if (!physical || /^CREATE VIRTUAL TABLE/i.test(String(physical.sql))) continue;
    const columns = await db.all(`PRAGMA main.table_info(${qident(table)})`);
    if (!columns.some(c => c.name === 'id' && c.pk === 1) || columns.filter(c => c.pk).length !== 1
      || !columns.some(c => c.name === 'deleted_at')) continue;
    const names = new Set(columns.map(c => c.name));
    const text = catalog.properties.filter(p => p.tbl === table && SEARCH_TEXT_TYPES.has(p.type ?? 'text') && names.has(p.col)).map(p => p.col).sort();
    if (!text.length) continue;
    const display = typeof entry.display === 'string' && names.has(entry.display) ? entry.display : undefined;
    const indexes = schema.filter(r => r.type === 'index' && r.tbl_name === table).map(r => r.sql).sort();
    const fingerprint = JSON.stringify([1, physical.sql, indexes, text, display]);
    // REPLACE can silently delete a victim of another UNIQUE constraint when
    // recursive_triggers is off. Only dirty tables with such constraints need
    // an indexed ID anti-join sweep; clean searches never scan source contents.
    const sweep = /unique|collate/i.test([physical.sql, ...indexes].join(' '));
    result.push({ table, columns: text, display, fingerprint, sweep });
  }
  return result;
}

async function purgeTable(db: SqlDriver, table: string) {
  await db.run('DELETE FROM _core_search_fts WHERE rowid IN (SELECT docid FROM _core_search_docs WHERE tbl=?)', [table]);
  await db.run('DELETE FROM _core_search_docs WHERE tbl=?', [table]);
  await db.run('DELETE FROM _core_search_dirty WHERE tbl=?', [table]);
  await db.run('DELETE FROM _core_search_state WHERE tbl=?', [table]);
}

/** Call only inside the same BEGIN IMMEDIATE transaction as the final query.
 * The durable queue catches core writes, pulls and Python writes while closed.
 * Fingerprints describe schemas/catalogs, never row timestamps or row contents. */
export async function prepareSearch(db: SqlDriver, catalog: Catalog): Promise<void> {
  await initSearch(db);
  const schema = await db.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE type IN ('table','index','trigger')");
  const tables = await indexedTables(db, catalog, schema);
  const expected = new Map(tables.flatMap(t => searchTriggers(t.table).map(trigger => [trigger.name, trigger.sql] as const)));
  for (const trigger of schema.filter(r => r.type === 'trigger' && String(r.name).startsWith('_core_search_'))) {
    if (expected.get(String(trigger.name)) !== trigger.sql) {
      // Never replace somebody else's trigger merely because its name matches.
      if (!isSearchTrigger(trigger)) throw new Error('Search trigger definition does not match the core contract.');
      await db.run(`DROP TRIGGER ${qident(String(trigger.name))}`);
    }
  }
  const states = await db.all('SELECT tbl,fingerprint FROM _core_search_state');
  for (const state of states) if (!tables.some(t => t.table === state.tbl)) await purgeTable(db, String(state.tbl));
  for (const indexed of tables) {
    const { table, columns, display } = indexed;
    const triggers = searchTriggers(table);
    const intact = triggers.every(t => schema.some(s => s.type === 'trigger' && s.name === t.name && s.sql === t.sql));
    if (!intact || states.find(s => s.tbl === table)?.fingerprint !== indexed.fingerprint) {
      await purgeTable(db, table);
      for (const trigger of triggers) {
        if (!schema.some(s => s.type === 'trigger' && s.name === trigger.name && s.sql === trigger.sql)) await db.run(trigger.sql);
      }
      await db.run(`INSERT INTO _core_search_dirty(tbl,row_id) SELECT ?,id FROM ${qident(table)} WHERE typeof(id)='text' AND id<>'' ON CONFLICT DO NOTHING`, [table]);
      await db.run('INSERT INTO _core_search_state(tbl,fingerprint) VALUES (?,?)', [table, indexed.fingerprint]);
    }
    const dirty = await db.all('SELECT 1 FROM _core_search_dirty WHERE tbl=? LIMIT 1', [table]);
    if (dirty.length && indexed.sweep) {
      const orphan = `SELECT docid FROM _core_search_docs AS d WHERE tbl=? AND NOT EXISTS (SELECT 1 FROM ${qident(table)} AS s WHERE s.id=d.row_id AND s.id COLLATE BINARY=d.row_id COLLATE BINARY)`;
      await db.run(`DELETE FROM _core_search_fts WHERE rowid IN (${orphan})`, [table]);
      await db.run(`DELETE FROM _core_search_docs WHERE docid IN (${orphan})`, [table]);
    }
    for (;;) {
      const pending = await db.all('SELECT row_id FROM _core_search_dirty WHERE tbl=? ORDER BY row_id LIMIT 200', [table]);
      if (!pending.length) break;
      const ids = JSON.stringify(pending.map(r => r.row_id));
      const select = [...new Set(['id', 'deleted_at', ...columns, ...(display ? [display] : [])])].map(qident).join(',');
      const rows = await db.all(`SELECT ${select} FROM ${qident(table)} WHERE id IN (SELECT value FROM json_each(?))`, [ids]);
      const payload = JSON.stringify(rows.map(row => ({ id: row.id, label: displayName(row, display), trashed: row.deleted_at === null ? 0 : 1,
        body: columns.map(col => typeof row[col] === 'string' || typeof row[col] === 'number' ? String(row[col]) : '').join('\n') })));
      await db.run('DELETE FROM _core_search_fts WHERE rowid IN (SELECT docid FROM _core_search_docs WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?)))', [table, ids]);
      await db.run('DELETE FROM _core_search_docs WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, ids]);
      await db.run("INSERT INTO _core_search_docs(tbl,row_id,label,trashed) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.label'),json_extract(value,'$.trashed') FROM json_each(?)", [table, payload]);
      await db.run("INSERT INTO _core_search_fts(rowid,body) SELECT d.docid,json_extract(j.value,'$.body') FROM json_each(?) AS j JOIN _core_search_docs AS d ON d.tbl=? AND d.row_id=json_extract(j.value,'$.id')", [payload, table]);
      await db.run('DELETE FROM _core_search_dirty WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, ids]);
    }
  }
}

/** Hosts may call at database open to fail early on incompatible SQLite.
 * No triggers, user rows or sync schema are changed by this capability probe. */
export async function assertSearchSupport(db: SqlDriver): Promise<void> {
  await db.transaction(async () => { await initSearch(db); });
}

/** Conservative display cleanup, not a Markdown parser or stored projection.
 * The index retains raw text, including URLs and syntax this does not recognize.
 * Hosts render the result as plain text, never HTML. */
function excerptText(text: string): string {
  // Protect inline code and link destinations from emphasis cleanup. Unknown
  // or truncated syntax remains text rather than being erased by a parser.
  return text.split(/(`+[^`\n]+`+|!?\[[^\]\n]*\]\([^()\n]*\)|https?:\/\/[^\s]+)/g)
    .map((part, index) => index % 2
      ? part.replace(/^(`+)([^`\n]+)\1$/, '$2').replace(/^!?\[([^\]\n]*)\]\(([^()\n]*)\)$/, '$1 ($2)')
      : part.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
        .replace(/(^|[\s(])([*_])(?=\S)([^\n]*?\S)\2(?=$|[\s.,!?;)])/g, '$1$3'))
    .join('').trim();
}

/** Search only the local replica. Missing/skipped remote tables are not queried. */
export async function search(db: SqlDriver, args: SearchArgs): Promise<SearchHit[]> {
  if (!args || typeof args !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Object.keys(args).some(k => !['text', 'table', 'limit', 'offset'].includes(k))) throw new Error('Invalid search arguments.');
  const query = compileSearch(args.text);
  const { table, limit = 50, offset = 0 } = args;
  if (table !== undefined && typeof table !== 'string') throw new Error('Invalid search table.');
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid search pagination.');
  return db.transaction(async () => {
    const catalog = await readCatalog(db);
    if (table !== undefined && !catalog.tables.some(t => t.id === table)) throw new Error('Table is not in the catalog');
    await prepareSearch(db, catalog);
    if (!query) return [];
    const hits = await db.all(`SELECT d.tbl AS "table",d.row_id AS id,d.label,substr(snippet(_core_search_fts,0,'','','...',24),1,512) AS excerpt
      FROM _core_search_fts JOIN _core_search_docs AS d ON d.docid=_core_search_fts.rowid
      WHERE _core_search_fts MATCH ? AND d.trashed=0 ${table === undefined ? '' : 'AND d.tbl=?'}
      ORDER BY bm25(_core_search_fts),d.tbl,d.row_id LIMIT ? OFFSET ?`, [query, ...(table === undefined ? [] : [table]), Math.min(limit, 200), offset]) as SearchHit[];
    return hits.map(hit => ({ ...hit, excerpt: excerptText(hit.excerpt) }));
  });
}
