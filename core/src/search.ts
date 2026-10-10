import type { Catalog, SearchArgs, SearchHit, SearchIndexStatus, SearchIndexStepArgs } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { catalogRevisionSQL, readCatalog } from './catalog.ts';
import { qident, type Row } from './validate.ts';
import { displayName } from './view.ts';
import { markdownMentions } from './mentions.ts';
import { isReadOnlyTable } from './write.ts';
import { SIZE_RULE_ROWS } from './sync.ts';

export const SEARCH_TEXT_TYPES = new Set(['text', 'markdown', 'select', 'url', 'email', 'phone', 'ref', 'date', 'datetime', 'date_or_datetime']);

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

/** Never indexed unless opted in: provenance edges repeat other rows' identities, not text anyone looks for. */
const UNSEARCHED = new Set(['provenance']);
/** Tables the sync size rule would leave out by default (more rows than this) stay out of the index too. */
export const SEARCH_MAX_ROWS = SIZE_RULE_ROWS;
/** `_core_state` key: a JSON object of table -> true (index it) or false (leave it out), overriding the defaults. */
export const SEARCH_TABLES_KEY = 'search_tables';
const CACHE = ['_core_search_fts', '_core_search_docs', '_core_search_dirty', '_core_search_state', '_core_search_mentions'];

/** Creates the cache tables; reads call it too, so a fresh replica answers from an empty index. */
async function initSearch(db: SqlDriver) {
  const names = new Set((await db.all("SELECT name FROM main.sqlite_master WHERE type='table' AND name GLOB '_core_search_*'")).map(r => r.name));
  const complete = CACHE.every(name => names.has(name));
  // Pending work arrived after the rest; an older complete cache simply has none.
  if (complete && names.has('_core_search_work')) return;
  if (!complete) {
    // These tables form one disposable cache. Recreating just one would leave
    // apparently current fingerprints beside an empty or stale index. Dropping
    // frees a large index without reading it back row by row.
    for (const name of [...CACHE, '_core_search_work']) if (names.has(name)) await db.run(`DROP TABLE ${qident(name)}`);
  }
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
  // Backlinks: Markdown mentions of live rows, rebuilt from bodies like the text index.
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_mentions (tbl TEXT NOT NULL, row_id TEXT NOT NULL, target_tbl TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(tbl,row_id,target_tbl,target_id)) WITHOUT ROWID');
  await db.run('CREATE INDEX IF NOT EXISTS _core_search_mentions_target ON _core_search_mentions(target_tbl,target_id)');
  // Per-table work the index step still owes: remove its entries (purge), then
  // index its rows in id order from `backfill` (NULL once complete or retired).
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_work (tbl TEXT PRIMARY KEY, purge INTEGER NOT NULL, backfill TEXT)');
}

type IndexedTable = { table: string; columns: string[]; markdown: string[]; display?: string; fingerprint: string; sweep: boolean };
async function describeTable(db: SqlDriver, entry: Row, catalog: Catalog, schema: Row[]): Promise<IndexedTable | null> {
  const table = String(entry.id);
  if (/^(_|sqlite_)/i.test(table)) return null;
  const physical = schema.find(r => r.type === 'table' && r.name === table);
  if (!physical || /^CREATE VIRTUAL TABLE/i.test(String(physical.sql))) return null;
  const columns = await db.all(`PRAGMA main.table_info(${qident(table)})`);
  if (!columns.some(c => c.name === 'id' && c.pk === 1) || columns.filter(c => c.pk).length !== 1
    || !columns.some(c => c.name === 'deleted_at')) return null;
  const names = new Set(columns.map(c => c.name));
  const text = catalog.properties.filter(p => p.tbl === table && SEARCH_TEXT_TYPES.has(p.type ?? 'text') && names.has(p.col)).map(p => p.col).sort();
  if (!text.length) return null;
  const markdown = catalog.properties.filter(p => p.tbl === table && p.type === 'markdown' && names.has(p.col)).map(p => p.col).sort();
  const display = typeof entry.display === 'string' && names.has(entry.display) ? entry.display : undefined;
  const indexes = schema.filter(r => r.type === 'index' && r.tbl_name === table).map(r => r.sql).sort();
  const fingerprint = JSON.stringify([2, physical.sql, indexes, text, display, markdown]);
  // REPLACE can silently delete a victim of another UNIQUE constraint when
  // recursive_triggers is off. Only dirty tables with such constraints need
  // an indexed ID anti-join sweep; clean searches never scan source contents.
  const sweep = /unique|collate/i.test([physical.sql, ...indexes].join(' '));
  return { table, columns: text, markdown, display, fingerprint, sweep };
}

const stateTable = async (db: SqlDriver) => (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='_core_state'")).length > 0;
/** The defaults' inputs: sync's stored hub row counts and the per-table choices. Unreadable values count as absent. */
async function searchSettings(db: SqlDriver) {
  const values = await stateTable(db) ? await db.all('SELECT key,value FROM main._core_state WHERE key IN (?,?)', ['hub_stats', SEARCH_TABLES_KEY]) : [];
  const parse = (key: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(String(values.find(r => r.key === key)?.value ?? 'null'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const counts = parse('hub_stats').tables;
  return { counts: (counts && typeof counts === 'object' ? counts : {}) as Record<string, unknown>, chosen: parse(SEARCH_TABLES_KEY) };
}
async function searched(db: SqlDriver, table: string, { counts, chosen }: Awaited<ReturnType<typeof searchSettings>>): Promise<boolean> {
  if (typeof chosen[table] === 'boolean') return chosen[table] as boolean;
  if (UNSEARCHED.has(table)) return false;
  if (Number.isSafeInteger(counts[table])) return (counts[table] as number) <= SEARCH_MAX_ROWS;
  // No hub count (never synced, or a local table): count locally, stopping just past the limit.
  const [row] = await db.all(`SELECT count(*) AS n FROM (SELECT 1 FROM ${qident(table)} LIMIT ${SEARCH_MAX_ROWS + 1})`);
  return Number(row?.n) <= SEARCH_MAX_ROWS;
}

/** The _core_state row recording the schema, catalog and settings of the last reconciliation. */
const READY = '';
/** The catalog revision, the size-rule inputs and every table, index and trigger definition, built and
 * compared inside SQLite: host bridges need not return row objects with a stable key order. */
async function searchStampSQL(db: SqlDriver): Promise<string> {
  const settings = await stateTable(db)
    ? `(SELECT ifnull(group_concat(key||'='||value,char(30)),'') FROM (SELECT key,value FROM main._core_state WHERE key IN ('hub_stats','${SEARCH_TABLES_KEY}') ORDER BY key))`
    : "''";
  return `${await catalogRevisionSQL(db)}||'|'||${settings}||'|'||(SELECT ifnull(group_concat(m,char(30)),'') FROM (SELECT type||char(31)||name||char(31)||tbl_name||char(31)||ifnull(sql,'') AS m
    FROM main.sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name))`;
}
/** Neither schema, catalog nor settings moved since the last reconciliation: the
 * tracked tables, their triggers and their fingerprints are all still right. */
async function reconciled(db: SqlDriver): Promise<boolean> {
  if (!(await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='_core_search_state'")).length) return false;
  const [ready] = await db.all(`SELECT fingerprint IS (${await searchStampSQL(db)}) AS same FROM _core_search_state WHERE tbl=?`, [READY]);
  return !!ready?.same;
}
/** Rows wait to be indexed: results may be incomplete. Call after initSearch. */
async function catchingUp(db: SqlDriver): Promise<boolean> {
  if (!(await reconciled(db))) return true;
  const [row] = await db.all('SELECT EXISTS(SELECT 1 FROM _core_search_dirty) OR EXISTS(SELECT 1 FROM _core_search_work WHERE backfill IS NOT NULL) AS behind');
  return !!row?.behind;
}

/** Brings tracked tables, triggers and fingerprints in line with the schema, catalog and
 * settings. It only records work (purges and backfills); the index step does it in chunks. */
async function reconcile(db: SqlDriver): Promise<void> {
  await initSearch(db);
  const catalog = await readCatalog(db);
  const schema = await db.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE type IN ('table','index','trigger')");
  const settings = await searchSettings(db);
  const tables: IndexedTable[] = [];
  for (const entry of catalog.tables) {
    const indexed = await describeTable(db, entry, catalog, schema);
    if (indexed && await searched(db, indexed.table, settings)) tables.push(indexed);
  }
  const expected = new Map(tables.flatMap(t => searchTriggers(t.table).map(trigger => [trigger.name, trigger.sql] as const)));
  for (const trigger of schema.filter(r => r.type === 'trigger' && String(r.name).startsWith('_core_search_'))) {
    if (expected.get(String(trigger.name)) !== trigger.sql) {
      // Never replace somebody else's trigger merely because its name matches.
      if (!isSearchTrigger(trigger)) throw new Error('Search trigger definition does not match the core contract.');
      await db.run(`DROP TRIGGER ${qident(String(trigger.name))}`);
    }
  }
  const states = await db.all('SELECT tbl,fingerprint FROM _core_search_state');
  for (const state of states) {
    if (state.tbl === READY || tables.some(t => t.table === state.tbl)) continue;
    // Retired (dropped, renamed, excluded): it stops answering now; its entries go in chunks.
    const retired = String(state.tbl);
    await db.run('DELETE FROM _core_search_dirty WHERE tbl=?', [retired]);
    await db.run('DELETE FROM _core_search_state WHERE tbl=?', [retired]);
    await db.run('INSERT INTO _core_search_work(tbl,purge,backfill) VALUES (?,1,NULL) ON CONFLICT(tbl) DO UPDATE SET purge=1,backfill=NULL', [retired]);
  }
  for (const indexed of tables) {
    const { table } = indexed;
    const triggers = searchTriggers(table);
    const intact = triggers.every(t => schema.some(s => s.type === 'trigger' && s.name === t.name && s.sql === t.sql));
    if (intact && states.find(s => s.tbl === table)?.fingerprint === indexed.fingerprint) continue;
    // Triggers queue every later change; the backfill walks the rows already there.
    const stale = (await db.all('SELECT 1 FROM _core_search_docs WHERE tbl=? LIMIT 1', [table])).length;
    await db.run("INSERT INTO _core_search_work(tbl,purge,backfill) VALUES (?,?,'') ON CONFLICT(tbl) DO UPDATE SET purge=excluded.purge,backfill=''", [table, stale]);
    for (const trigger of triggers) {
      if (!schema.some(s => s.type === 'trigger' && s.name === trigger.name && s.sql === trigger.sql)) await db.run(trigger.sql);
    }
    await db.run('INSERT INTO _core_search_state(tbl,fingerprint) VALUES (?,?) ON CONFLICT(tbl) DO UPDATE SET fingerprint=excluded.fingerprint', [table, indexed.fingerprint]);
  }
  await db.run(`INSERT INTO _core_search_state(tbl,fingerprint) SELECT ?,${await searchStampSQL(db)} WHERE true ON CONFLICT(tbl) DO UPDATE SET fingerprint=excluded.fingerprint`, [READY]);
}

/** Replaces the index entries of these queued or walked IDs with their rows' current text. */
async function indexBatch(db: SqlDriver, indexed: IndexedTable, ids: unknown[]) {
  const { table, columns, display } = indexed;
  const select = [...new Set(['id', 'deleted_at', ...columns, ...(display ? [display] : [])])].map(qident).join(',');
  const rows = await db.all(`SELECT ${select} FROM ${qident(table)} WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
  // Source PK collation can resolve a queued spelling to a different ID.
  // Replace both identities: aliases in later batches may resolve to a row
  // already indexed by an earlier batch. Cache and queue keys are binary.
  const replacedIds = JSON.stringify([...new Set([...ids, ...rows.map(r => r.id)])]);
  const payload = JSON.stringify(rows.map(row => ({ id: row.id, label: displayName(row, display), trashed: row.deleted_at === null ? 0 : 1,
    body: columns.map(col => typeof row[col] === 'string' || typeof row[col] === 'number' ? String(row[col]) : '').join('\n') })));
  await db.run('DELETE FROM _core_search_fts WHERE rowid IN (SELECT docid FROM _core_search_docs WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?)))', [table, replacedIds]);
  await db.run('DELETE FROM _core_search_docs WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, replacedIds]);
  await db.run('DELETE FROM _core_search_mentions WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, replacedIds]);
  const mentions = JSON.stringify(rows.filter(row => row.deleted_at === null).flatMap(row => indexed.markdown
    .flatMap(col => typeof row[col] === 'string' ? markdownMentions(row[col] as string) : [])
    .map(target => [row.id, target.table, target.id])));
  await db.run("INSERT OR IGNORE INTO _core_search_mentions(tbl,row_id,target_tbl,target_id) SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?)", [table, mentions]);
  await db.run("INSERT INTO _core_search_docs(tbl,row_id,label,trashed) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.label'),json_extract(value,'$.trashed') FROM json_each(?)", [table, payload]);
  // CROSS JOIN keeps the batch outermost: one docs lookup per row, never a range over the table's docs.
  await db.run("INSERT INTO _core_search_fts(rowid,body) SELECT d.docid,json_extract(j.value,'$.body') FROM json_each(?) AS j CROSS JOIN _core_search_docs AS d ON d.tbl=? AND d.row_id=json_extract(j.value,'$.id')", [payload, table]);
}

const BATCH = 200, PURGE_BATCH = 500;
/** One unit of owed work, in order: purges, queued changes, backfills. False when none is left. */
async function indexChunk(db: SqlDriver, describe: (table: string) => Promise<IndexedTable | null>, swept: Set<string>): Promise<boolean> {
  const [purge] = await db.all('SELECT tbl FROM _core_search_work WHERE purge=1 LIMIT 1');
  if (purge) {
    const table = String(purge.tbl);
    const doomed = await db.all('SELECT docid,row_id FROM _core_search_docs WHERE tbl=? LIMIT ?', [table, PURGE_BATCH]);
    if (!doomed.length) {
      await db.run('DELETE FROM _core_search_mentions WHERE tbl=?', [table]);
      await db.run('UPDATE _core_search_work SET purge=0 WHERE tbl=?', [table]);
      await db.run('DELETE FROM _core_search_work WHERE tbl=? AND backfill IS NULL', [table]);
      return true;
    }
    const docids = JSON.stringify(doomed.map(r => r.docid));
    await db.run('DELETE FROM _core_search_fts WHERE rowid IN (SELECT value FROM json_each(?))', [docids]);
    await db.run('DELETE FROM _core_search_docs WHERE docid IN (SELECT value FROM json_each(?))', [docids]);
    await db.run('DELETE FROM _core_search_mentions WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, JSON.stringify(doomed.map(r => r.row_id))]);
    return true;
  }
  const [dirty] = await db.all('SELECT tbl FROM _core_search_dirty LIMIT 1');
  if (dirty) {
    const table = String(dirty.tbl), indexed = await describe(table);
    if (!indexed) {
      await db.run('DELETE FROM _core_search_dirty WHERE tbl=?', [table]);
      return true;
    }
    if (indexed.sweep && !swept.has(table)) {
      swept.add(table);
      const orphan = `SELECT docid FROM _core_search_docs AS d WHERE tbl=? AND NOT EXISTS (SELECT 1 FROM ${qident(table)} AS s WHERE s.id=d.row_id AND s.id COLLATE BINARY=d.row_id COLLATE BINARY)`;
      await db.run(`DELETE FROM _core_search_mentions WHERE tbl=? AND row_id IN (SELECT row_id FROM _core_search_docs WHERE docid IN (${orphan}))`, [table, table]);
      await db.run(`DELETE FROM _core_search_fts WHERE rowid IN (${orphan})`, [table]);
      await db.run(`DELETE FROM _core_search_docs WHERE docid IN (${orphan})`, [table]);
    }
    // Queued IDs are never empty, so the batch is a keyset range seek like the backfill's.
    const ids = (await db.all("SELECT row_id FROM _core_search_dirty WHERE tbl=? AND row_id>'' ORDER BY row_id LIMIT ?", [table, BATCH])).map(r => r.row_id);
    await indexBatch(db, indexed, ids);
    await db.run('DELETE FROM _core_search_dirty WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, JSON.stringify(ids)]);
    return true;
  }
  const [walk] = await db.all('SELECT tbl,backfill FROM _core_search_work WHERE backfill IS NOT NULL LIMIT 1');
  if (!walk) return false;
  const table = String(walk.tbl), indexed = await describe(table);
  // The primary key index keeps each page a range seek, whatever the table's size.
  const ids = indexed ? (await db.all(`SELECT id FROM ${qident(table)} WHERE typeof(id)='text' AND id>? ORDER BY id LIMIT ?`, [String(walk.backfill), BATCH])).map(r => String(r.id)) : [];
  if (!ids.length) await db.run('DELETE FROM _core_search_work WHERE tbl=?', [table]);
  else {
    await indexBatch(db, indexed!, ids);
    await db.run('UPDATE _core_search_work SET backfill=? WHERE tbl=?', [ids[ids.length - 1]!, table]);
  }
  return true;
}

async function indexStatus(db: SqlDriver): Promise<SearchIndexStatus> {
  let pending = Number((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0]?.n ?? 0), purging = false;
  for (const work of await db.all('SELECT tbl,purge,backfill FROM _core_search_work')) {
    purging ||= !!work.purge;
    if (work.backfill === null) continue;
    const [row] = await db.all(`SELECT count(*) AS n FROM ${qident(String(work.tbl))} WHERE typeof(id)='text' AND id>?`, [String(work.backfill)]);
    pending += Number(row?.n ?? 0);
  }
  return { indexing: pending > 0, pending, done: pending === 0 && !purging };
}

/** The only operation that builds the search index. Hosts call it after each sync round,
 * after local writes and while idle, until `done`. Each call is one transaction: it
 * reconciles if the schema, catalog or settings moved, then indexes or removes chunks of
 * rows until `budgetMs` passes (always at least one chunk), so requests between calls
 * never wait long. Searches and backlinks read whatever it has built so far. */
export async function searchIndexStep(db: SqlDriver, args: SearchIndexStepArgs = {}): Promise<SearchIndexStatus> {
  if (!args || typeof args !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Object.keys(args).some(k => k !== 'budgetMs')) throw new Error('Invalid search index arguments.');
  const { budgetMs = 50 } = args;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0) throw new Error('Invalid search index budget.');
  return db.transaction(async () => {
    const started = Date.now();
    if (!(await reconciled(db))) await reconcile(db);
    const described = new Map<string, Promise<IndexedTable | null>>(), swept = new Set<string>();
    // Reconciliation is current, so a tracked table's description still matches its fingerprint.
    const describe = (table: string) => {
      if (!described.has(table)) described.set(table, (async () => {
        if (!(await db.all('SELECT 1 FROM _core_search_state WHERE tbl=? AND tbl<>?', [table, READY])).length) return null;
        const catalog = await readCatalog(db, [table]);
        const schema = await db.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE type IN ('table','index') AND tbl_name=?", [table]);
        return catalog.tables[0] ? describeTable(db, catalog.tables[0], catalog, schema) : null;
      })());
      return described.get(table)!;
    };
    while (await indexChunk(db, describe, swept) && Date.now() - started < budgetMs);
    return indexStatus(db);
  });
}

/** Hosts may call at database open to fail early on incompatible SQLite.
 * No triggers, user rows or sync schema are changed by this capability probe. */
export async function assertSearchSupport(db: SqlDriver): Promise<void> {
  await db.transaction(async () => { await initSearch(db); });
}

/** Reads that join the index (view search, backlinks) call this so a replica the step has not
 * reached yet answers from an empty index instead of failing. It never indexes anything. */
export const openSearchIndex = initSearch;
/** Whether rows still wait for the index step, for reads that report it. */
export async function searchIndexing(db: SqlDriver): Promise<boolean> {
  await initSearch(db);
  return catchingUp(db);
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

async function readCatalogTables(db: SqlDriver): Promise<Catalog> {
  const exists = (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='catalog_tables'")).length;
  return { tables: exists ? await db.all('SELECT * FROM catalog_tables WHERE deleted_at IS NULL ORDER BY id') : [], properties: [], rules: [] };
}

/** Search only the local replica, as far as the index step has indexed it. Missing/skipped
 * remote tables are not queried; this never builds or drains the index. */
export async function search(db: SqlDriver, args: SearchArgs): Promise<SearchHit[]> {
  if (!args || typeof args !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Object.keys(args).some(k => !['text', 'table', 'limit', 'offset'].includes(k))) throw new Error('Invalid search arguments.');
  const query = compileSearch(args.text);
  const { table, limit = 50, offset = 0 } = args;
  if (table !== undefined && typeof table !== 'string') throw new Error('Invalid search table.');
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid search pagination.');
  return db.transaction(async () => {
    // Searching reads the index as the step left it; only the table entries are needed.
    const catalog = await readCatalogTables(db);
    if (table !== undefined && !catalog.tables.some(t => t.id === table)) throw new Error('Table is not in the catalog');
    await initSearch(db);
    if (!query) return [];
    // Read-only system rows (history, provenance, catalog) repeat user text; list them after records.
    const system = catalog.tables.filter(t => isReadOnlyTable(String(t.id), t)).map(t => String(t.id));
    // A retired table stops answering at once, before the step has purged its entries.
    const scope = `d.trashed=0 AND d.tbl IN (SELECT tbl FROM _core_search_state)${table === undefined ? '' : ' AND d.tbl=?'}`, scoped = table === undefined ? [] : [table];
    // Relevance and excerpts cost work per match; a one-letter prefix matches most of a large
    // estate. Rank the newest SEARCH_RANKED_MATCHES live matches in scope (all of them below it).
    const hits = await db.all(`SELECT d.docid,d.tbl AS "table",d.row_id AS id,d.label
      FROM _core_search_fts JOIN _core_search_docs AS d ON d.docid=_core_search_fts.rowid
      WHERE _core_search_fts MATCH ? AND ${scope} AND _core_search_fts.rowid>=ifnull((SELECT f.rowid FROM _core_search_fts AS f
        JOIN _core_search_docs AS d ON d.docid=f.rowid WHERE f._core_search_fts MATCH ? AND ${scope}
        ORDER BY f.rowid DESC LIMIT 1 OFFSET ${SEARCH_RANKED_MATCHES - 1}),0)
      ORDER BY d.tbl IN (${system.map(() => '?').join(',')}),bm25(_core_search_fts),d.tbl,d.row_id LIMIT ? OFFSET ?`,
      [query, ...scoped, query, ...scoped, ...system, Math.min(limit, 200), offset]);
    // Excerpts read stored bodies by rowid; re-running MATCH per hit expands every prefix again.
    const bodies = new Map((await db.all('SELECT rowid,body FROM _core_search_fts WHERE rowid IN (SELECT value FROM json_each(?))',
      [JSON.stringify(hits.map(h => h.docid))])).map(r => [r.rowid, String(r.body ?? '')]));
    const terms = (args.text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).map(fold);
    return hits.map(({ docid, ...hit }) => ({ ...hit, excerpt: excerptText(excerpt(bodies.get(docid) ?? '', terms)) }) as SearchHit);
  });
}

/** Ranked matches per search; more matches than this rank only the most recently indexed. */
export const SEARCH_RANKED_MATCHES = 2000;
const EXCERPT_WORDS = 24;
const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** snippet()'s window: up to EXCERPT_WORDS words centred on the first word starting with a
 * search term (diacritics folded like the unicode61 tokenizer), '...' where text is cut.
 * Without such a word (another folding rule), the window starts at the beginning. */
function excerpt(body: string, terms: string[]): string {
  const word = /[\p{L}\p{N}\p{M}]+/gu, words: [number, number][] = [];
  let hit = -1, cutBefore = false, cutAfter = false;
  for (let match; (match = word.exec(body));) {
    if (hit >= 0 && words.length >= EXCERPT_WORDS && words.length - hit > EXCERPT_WORDS / 2) { cutAfter = true; break; }
    words.push([match.index, match.index + match[0].length]);
    if (hit < 0 && terms.some(term => fold(match[0]).startsWith(term))) hit = words.length - 1;
    else if (hit < 0 && words.length > EXCERPT_WORDS) { words.shift(); cutBefore = true; }
  }
  if (hit < 0) return terms.length === 1 && terms[0] === '' ? body.slice(0, 512) : excerpt(body, ['']);
  // Collection stops half a window past the hit, so the last EXCERPT_WORDS words centre it.
  const first = Math.max(0, words.length - EXCERPT_WORDS);
  const last = Math.min(words.length, first + EXCERPT_WORDS) - 1;
  cutBefore ||= first > 0;
  cutAfter ||= last < words.length - 1;
  const text = body.slice(cutBefore ? words[first]![0] : 0, cutAfter ? words[last]![1] : body.length);
  return `${cutBefore ? '...' : ''}${text}${cutAfter ? '...' : ''}`.slice(0, 512);
}

