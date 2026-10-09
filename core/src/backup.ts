import type { SqlDriver } from './driver.ts';
import type { ServiceHub } from './services.ts';
import { initCore } from './sync.ts';
import { qident, validEditTimestamp, type Row } from './validate.ts';
import type { BackupSummary, BackupTableSummary, HubBackup, HubBackupList, RestorePreview, RestoreResult, RestoreArgs } from './contract.generated.ts';
export type { BackupSummary, BackupTableSummary, HubBackup, HubBackupList, RestorePreview, RestoreResult } from './contract.generated.ts';

/** Version of the SQL dump shape: `life export`, hub backups and exportReplica.
 * A dump without the header line is the same version-1 shape. */
export const DUMP_VERSION = 1;
export const DUMP_HEADER = `-- life-data-dump: ${DUMP_VERSION}`;

/** Successive text chunks of one dump, gzip already removed and checked by the host. */
export interface DumpSource { read(): Promise<string | null> }
export interface DumpSink { write(text: string): Promise<void>; close(): Promise<void> }
/** Host-owned files named by opaque references. open() starts a fresh read each
 * call; create() replaces the destination and close() makes it durable. */
export interface BackupFiles { open(file: string): DumpSource; create(file: string): DumpSink }

export class BackupInvalid extends Error { name = 'BackupInvalid'; }
const invalid = (message: string) => new BackupInvalid(message);

// --- statement splitting -----------------------------------------------------

const SCAN = /['"`[;]|--|\/\*/g;
const SCAN_TRIGGER = /['"`[;]|--|\/\*|\b(?:CASE|END)\b/gi;
const SKIP: Record<string, RegExp> = {
  "'": /'[^']*(?:''[^']*)*'/y, '"': /"[^"]*(?:""[^"]*)*"/y, '`': /`[^`]*(?:``[^`]*)*`/y,
  '[': /\[[^\]]*\]/y, '--': /--[^\n]*\n/y, '/*': /\/\*[\s\S]*?\*\//y,
};
const LEAD = /(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/y;

/** Index of the terminating `;`, or null when the buffer must grow first.
 * Trigger bodies hold `;` until their own END (CASE ... END nests). Each call
 * rescans from the statement's start, so a token cut by the buffer's end (half
 * of a '' escape, END of ENDS) is read whole on the next call. */
function statementEnd(buf: string, start: number, eof: boolean): number | null {
  LEAD.lastIndex = start;
  LEAD.exec(buf);
  const body = LEAD.lastIndex;
  if (!eof && buf.length - body < 64) return null;
  const trigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(buf.slice(body, body + 64));
  const scan = trigger ? SCAN_TRIGGER : SCAN;
  scan.lastIndex = body;
  let depth = 0, ended = false;
  for (let m: RegExpExecArray | null; (m = scan.exec(buf));) {
    const token = m[0];
    if (token === ';') {
      if (!trigger || ended) return m.index;
      continue;
    }
    if (/^[a-z]/i.test(token)) {
      if (token.toUpperCase() === 'CASE') depth++;
      else if (depth) depth--;
      else ended = true;
      continue;
    }
    const skip = SKIP[token]!;
    skip.lastIndex = m.index;
    if (!skip.exec(buf)) {
      if (eof && token === '--') return null;
      if (eof) throw invalid('The backup ends inside a quoted value or comment.');
      return null;
    }
    scan.lastIndex = skip.lastIndex;
  }
  return null;
}

async function* statements(source: DumpSource): AsyncGenerator<string> {
  let buf = '', pos = 0, eof = false;
  while (true) {
    const end = statementEnd(buf, pos, eof);
    if (end !== null) {
      yield buf.slice(pos, end);
      pos = end + 1;
      continue;
    }
    if (eof) {
      LEAD.lastIndex = pos;
      LEAD.exec(buf);
      if (LEAD.lastIndex < buf.length && buf.slice(LEAD.lastIndex).trim()) {
        throw invalid('The backup ends in the middle of a statement.');
      }
      return;
    }
    let chunk: string | null;
    try { chunk = await source.read(); }
    catch (error) { throw invalid(`The backup file could not be read: ${error instanceof Error ? error.message : 'read failed'}`); }
    if (chunk === null) eof = true;
    else if (typeof chunk !== 'string') throw invalid('The backup file could not be read.');
    else {
      buf = buf.slice(pos) + chunk;
      pos = 0;
    }
  }
}

// --- statement parsing -------------------------------------------------------

type Value = { kind: 'null' } | { kind: 'num'; text: string } | { kind: 'str'; value: string } | { kind: 'blob'; hex: string };
type TokenKind = 'str' | 'id' | 'word' | 'num' | 'op' | 'eof';
const TOKEN = /(\s+|--[^\n]*|\/\*[\s\S]*?\*\/)|('[^']*(?:''[^']*)*')|("[^"]*(?:""[^"]*)*"|`[^`]*(?:``[^`]*)*`|\[[^\]]*\])|([A-Za-z_][A-Za-z0-9_$]*)|([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|(\|\||[\s\S])/y;

class Tokens {
  kind: TokenKind = 'eof';
  text = '';
  start = 0;
  end = 0;
  constructor(private readonly s: string) { this.next(); }
  next(): void {
    TOKEN.lastIndex = this.end;
    for (let m: RegExpExecArray | null; (m = TOKEN.exec(this.s));) {
      if (m[1] !== undefined) continue;
      this.start = m.index;
      this.end = TOKEN.lastIndex;
      this.text = m[0];
      this.kind = m[2] !== undefined ? 'str' : m[3] !== undefined ? 'id' : m[4] !== undefined ? 'word' : m[5] !== undefined ? 'num' : 'op';
      return;
    }
    this.kind = 'eof';
    this.text = '';
    this.start = this.end = this.s.length;
  }
  // Methods, not field comparisons: TypeScript would keep narrowing across next().
  at(kind: TokenKind): boolean { return this.kind === kind; }
  op(text: string): boolean { return this.kind === 'op' && this.text === text; }
  is(word: string): boolean { return this.kind === 'word' && this.text.toUpperCase() === word; }
  take(word: string): boolean {
    if (!this.is(word)) return false;
    this.next();
    return true;
  }
  expect(text: string): void {
    if (this.kind !== 'op' || this.text !== text) throw unsupported();
    this.next();
  }
  name(): string {
    const { kind, text } = this;
    if (kind === 'word') { this.next(); return text; }
    if (kind === 'str') { this.next(); return unquote(text); } // SQLite accepts 'name' (Python's dump uses it)
    if (kind !== 'id') throw unsupported();
    this.next();
    const quote = text[0]!;
    return quote === '[' ? text.slice(1, -1) : text.slice(1, -1).split(quote + quote).join(quote);
  }
  rest(): string { return this.s.slice(this.start); }
}
const unsupported = (what = 'statement') => invalid(`The backup contains an unsupported ${what}.`);
const unquote = (literal: string) => literal.slice(1, -1).replaceAll("''", "'");

function value(t: Tokens): Value {
  if (t.at('num')) { const text = t.text; t.next(); return { kind: 'num', text }; }
  if (t.at('str')) { const v = unquote(t.text); t.next(); return { kind: 'str', value: v }; }
  if (!t.at('word')) throw unsupported('value');
  const word = t.text.toUpperCase(), at = t.end;
  t.next();
  if (word === 'NULL') return { kind: 'null' };
  if (word === 'X' && t.at('str') && t.start === at && /^'(?:[0-9a-fA-F]{2})*'$/.test(t.text)) {
    const hex = t.text.slice(1, -1); t.next(); return { kind: 'blob', hex };
  }
  // D1 exports spell newlines and carriage returns as replace('a\nb','\n',char(10)).
  if (word === 'REPLACE') {
    t.expect('(');
    const target = value(t); t.expect(',');
    const from = value(t); t.expect(',');
    const to = value(t); t.expect(')');
    if (target.kind !== 'str' || from.kind !== 'str' || !from.value || to.kind !== 'str') throw unsupported('value');
    return { kind: 'str', value: target.value.split(from.value).join(to.value) };
  }
  if (word === 'CHAR') {
    t.expect('(');
    let out = '';
    do {
      if (!t.at('num') || !/^\d+$/.test(t.text) || Number(t.text) > 0x10ffff) throw unsupported('value');
      out += String.fromCodePoint(Number(t.text));
      t.next();
    } while (t.op(',') && (t.next(), true));
    t.expect(')');
    return { kind: 'str', value: out };
  }
  throw unsupported('value');
}
function literal(v: Value): string {
  switch (v.kind) {
    case 'null': return 'NULL';
    case 'num': return v.text;
    case 'blob': return `X'${v.hex}'`;
    case 'str': return `'${v.value.replaceAll("'", "''")}'`;
  }
}

type Parsed =
  | { kind: 'skip' } | { kind: 'begin' } | { kind: 'commit' }
  | { kind: 'table'; name: string; columns: string[]; sql: string }
  | { kind: 'ignoredTable'; name: string }
  | { kind: 'ddl'; name: string; table: string | null; sql: string }
  | { kind: 'rows'; table: string; columns: string[] | null; rows: Value[][] };

const ignoredName = (name: string) => /^(?:_|sqlite_)/i.test(name) && name !== '_schema_log';
const ifNotExists = (t: Tokens) => { if (t.take('IF')) { if (!t.take('NOT') || !t.take('EXISTS')) throw unsupported(); } };

function tableColumns(t: Tokens): string[] {
  t.expect('(');
  const columns: string[] = [];
  let depth = 1, first = true;
  while (depth > 0) {
    if (t.at('eof')) throw unsupported('table definition');
    if (first && depth === 1) {
      first = false;
      if (!['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].some(k => t.is(k))) { columns.push(t.name()); continue; }
    }
    if (t.op('(')) depth++;
    else if (t.op(')')) depth--;
    else if (t.op(',') && depth === 1) first = true;
    t.next();
  }
  while (t.at('word') || (t.op(','))) t.next(); // WITHOUT ROWID, STRICT
  if (!t.at('eof')) throw unsupported('table definition');
  if (!columns.length || new Set(columns.map(c => c.toLowerCase())).size !== columns.length) throw unsupported('table definition');
  return columns;
}

function parse(text: string): Parsed {
  const t = new Tokens(text);
  if (t.at('eof')) return { kind: 'skip' };
  const sql = t.rest();
  if (t.take('PRAGMA')) {
    const pragma = t.at('word') ? t.text.toLowerCase() : '';
    t.next(); t.expect('=');
    if (!['foreign_keys', 'defer_foreign_keys', 'writable_schema'].includes(pragma)) throw unsupported('PRAGMA');
    t.next();
    if (!t.at('eof')) throw unsupported('PRAGMA');
    return { kind: 'skip' };
  }
  if (t.take('BEGIN')) { t.take('TRANSACTION'); if (!t.at('eof')) throw unsupported(); return { kind: 'begin' }; }
  if (t.take('COMMIT') || t.take('END')) { t.take('TRANSACTION'); if (!t.at('eof')) throw unsupported(); return { kind: 'commit' }; }
  if (t.take('ANALYZE')) return { kind: 'skip' };
  if (t.take('DELETE')) {
    if (!t.take('FROM') || !/^sqlite_sequence$/i.test(t.name()) || !t.at('eof')) throw unsupported();
    return { kind: 'skip' };
  }
  if (t.take('CREATE')) {
    if (t.take('TABLE')) {
      ifNotExists(t);
      const name = t.name();
      if (ignoredName(name)) return { kind: 'ignoredTable', name };
      return { kind: 'table', name, columns: tableColumns(t), sql };
    }
    if (t.take('VIRTUAL')) {
      if (!t.take('TABLE')) throw unsupported();
      ifNotExists(t);
      const name = t.name();
      if (/^_/.test(name)) return { kind: 'ignoredTable', name };
      throw unsupported('virtual table');
    }
    t.take('UNIQUE');
    if (t.take('INDEX')) {
      ifNotExists(t);
      const name = t.name();
      if (!t.take('ON')) throw unsupported();
      return { kind: 'ddl', name, table: t.name(), sql };
    }
    if (t.take('TRIGGER')) {
      ifNotExists(t);
      const name = t.name();
      while (!t.at('eof') && !t.is('ON')) t.next();
      if (!t.take('ON')) throw unsupported();
      return { kind: 'ddl', name, table: t.name(), sql };
    }
    if (t.take('VIEW')) {
      ifNotExists(t);
      return { kind: 'ddl', name: t.name(), table: null, sql };
    }
    throw unsupported();
  }
  if (t.take('INSERT')) {
    if (t.take('OR')) { if (!t.take('REPLACE') && !t.take('IGNORE')) throw unsupported(); }
    if (!t.take('INTO')) throw unsupported();
    const table = t.name();
    let columns: string[] | null = null;
    if (t.op('(')) {
      t.next();
      columns = [];
      do columns.push(t.name()); while (t.op(',') && (t.next(), true));
      t.expect(')');
    }
    if (!t.take('VALUES')) throw unsupported();
    const rows: Value[][] = [];
    do {
      t.expect('(');
      const row: Value[] = [];
      do row.push(value(t)); while (t.op(',') && (t.next(), true));
      t.expect(')');
      rows.push(row);
    } while (t.op(',') && (t.next(), true));
    if (!t.at('eof')) throw unsupported();
    return { kind: 'rows', table, columns, rows };
  }
  throw unsupported();
}

// --- reading a dump ------------------------------------------------------------

type TableState = BackupTableSummary & { columns: string[]; updated: number; deleted: number };
const SCHEMA_LOG = ['id', 'applied_at', 'ddl'];

/** Restoration hooks; validation runs the same walk without them. */
interface Apply {
  table(name: string, sql: string): Promise<void>;
  rows(table: string, columns: string[], tuples: string[]): Promise<void>;
  ddl(sql: string): Promise<void>;
}

/** The summary plus the dump's statement length, which also catches edits that keep the counts. */
async function readDump(source: DumpSource, apply?: Apply): Promise<{ summary: BackupSummary; characters: number }> {
  let version: number | null = null, began = false, committed = false, first = true;
  let schemaLog: string[] | null = null, schemaEntries = 0;
  const tables = new Map<string, TableState>();
  const ignored = new Set<string>();
  const deferred: string[] = [];
  let pending: { table: string; columns: string[]; tuples: string[]; bytes: number } | null = null;
  const flush = async () => {
    if (pending?.tuples.length && apply) await apply.rows(pending.table, pending.columns, pending.tuples);
    pending = null;
  };
  let characters = 0;
  for await (const text of statements(source)) {
    characters += text.length;
    if (first) {
      first = false;
      const header = /^﻿?\s*-- life-data-dump: *(\d+)\s*\n/.exec(text);
      version = header ? Number(header[1]) : DUMP_VERSION;
      if (version !== DUMP_VERSION) throw invalid(`This backup uses dump format ${version}; this app reads format ${DUMP_VERSION}. Update the app first.`);
    }
    const statement = parse(text);
    if (statement.kind === 'skip') continue;
    if (committed) throw invalid('The backup has statements after its final COMMIT.');
    if (statement.kind === 'begin') {
      if (began || tables.size || schemaLog) throw unsupported('transaction');
      began = true;
      continue;
    }
    if (statement.kind === 'commit') {
      if (!began) throw unsupported('transaction');
      committed = true;
      continue;
    }
    if (statement.kind === 'ignoredTable') { ignored.add(statement.name.toLowerCase()); continue; }
    if (statement.kind === 'table') {
      const key = statement.name.toLowerCase();
      if (tables.has(key) || ignored.has(key) || (key === '_schema_log' && schemaLog)) throw invalid(`The backup declares table ${statement.name} twice.`);
      if (key === '_schema_log') {
        schemaLog = statement.columns.map(c => c.toLowerCase());
        if (schemaLog.length !== 3 || !SCHEMA_LOG.every(c => schemaLog!.includes(c))) {
          throw invalid('This backup has an unsupported schema version: its _schema_log is not (id, applied_at, ddl).');
        }
        continue;
      }
      await flush();
      if (apply) await apply.table(statement.name, statement.sql);
      const lower = statement.columns.map(c => c.toLowerCase());
      tables.set(key, { table: statement.name, rows: 0, liveRows: 0, newestUpdatedAt: null, columns: statement.columns,
        updated: lower.indexOf('updated_at'), deleted: lower.indexOf('deleted_at') });
      continue;
    }
    if (statement.kind === 'ddl') {
      const target = statement.table?.toLowerCase();
      if (ignoredName(statement.name) || (target !== undefined && (ignoredName(target) || ignored.has(target)))) continue;
      if (target !== undefined && !tables.has(target)) throw invalid(`The backup indexes or triggers an undeclared table ${statement.table}.`);
      deferred.push(statement.sql);
      continue;
    }
    // Rows.
    const key = statement.table.toLowerCase();
    if (key === 'sqlite_master') {
      // Python's dump writes virtual tables (core's search cache) this way.
      if (statement.columns?.join(',').toLowerCase() !== 'type,name,tbl_name,rootpage,sql'
        || statement.rows.some(r => r[1]?.kind !== 'str' || !/^_/.test(r[1].value))) throw unsupported('virtual table');
      continue;
    }
    if (ignoredName(key)) continue;
    const declared = key === '_schema_log' ? (schemaLog ?? null) : tables.get(key)?.columns ?? null;
    if (!declared) throw invalid(`The backup has rows for an undeclared table ${statement.table}.`);
    const lower = declared.map(c => c.toLowerCase());
    const columns = statement.columns ?? declared;
    if (statement.columns && (new Set(columns.map(c => c.toLowerCase())).size !== columns.length
      || columns.some(c => !lower.includes(c.toLowerCase())))) throw invalid(`The backup has rows with unknown columns for ${statement.table}.`);
    if (statement.rows.some(r => r.length !== columns.length)) throw invalid(`The backup has a malformed row for ${statement.table}.`);
    const state = tables.get(key);
    const targetColumns = key === '_schema_log' ? columns.map(c => SCHEMA_LOG.find(s => s === c.toLowerCase())!) : columns;
    if (state) {
      const index = (i: number) => i < 0 ? -1 : columns.findIndex(c => c.toLowerCase() === lower[i]);
      const updated = index(state.updated), deleted = index(state.deleted);
      for (const row of statement.rows) {
        state.rows++;
        if (deleted < 0 || row[deleted]!.kind === 'null') state.liveRows++;
        const stamp = updated < 0 ? undefined : row[updated];
        if (stamp?.kind === 'str' && (state.newestUpdatedAt === null || stamp.value > state.newestUpdatedAt)) state.newestUpdatedAt = stamp.value;
      }
    } else schemaEntries += statement.rows.length;
    if (!apply) continue;
    const target = key === '_schema_log' ? '_schema_log' : statement.table;
    const signature = targetColumns.join('\u0000');
    if (pending && (pending.table !== target || pending.columns.join('\u0000') !== signature)) await flush();
    pending ??= { table: target, columns: targetColumns, tuples: [], bytes: 0 };
    for (const row of statement.rows) {
      const tuple = `(${row.map(literal).join(',')})`;
      pending.tuples.push(tuple);
      pending.bytes += tuple.length;
      // SQLite caps a VALUES list at 500 rows (SQLITE_MAX_COMPOUND_SELECT).
      if (pending.tuples.length >= 200 || pending.bytes >= 1 << 20) {
        await flush();
        pending = { table: target, columns: targetColumns, tuples: [], bytes: 0 };
      }
    }
  }
  await flush();
  if (first) throw invalid('The backup is empty.');
  if (began && !committed) throw invalid('The backup is incomplete: it has no final COMMIT.');
  if (!schemaLog) throw invalid('This backup has an unsupported schema version: it has no _schema_log.');
  if (apply) for (const sql of deferred) await apply.ddl(sql);
  return { summary: summarize([...tables.values()], schemaEntries, version ?? DUMP_VERSION), characters };
}

function summarize(states: BackupTableSummary[], schemaEntries: number, version = DUMP_VERSION): BackupSummary {
  const tables = states.map(({ table, rows, liveRows, newestUpdatedAt }) => ({ table, rows, liveRows, newestUpdatedAt }))
    .sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0);
  const newest = tables.reduce<string | null>((m, t) => t.newestUpdatedAt !== null && (m === null || t.newestUpdatedAt > m) ? t.newestUpdatedAt : m, null);
  return { version, tables, rows: tables.reduce((n, t) => n + t.rows, 0), newestUpdatedAt: newest, schemaEntries };
}

// --- operations ---------------------------------------------------------------

export async function validateBackup(source: DumpSource): Promise<BackupSummary> {
  return (await readDump(source)).summary;
}

/** Counts of the live replica, in the same shape as a backup summary. */
export async function replicaSummary(db: SqlDriver): Promise<BackupSummary> {
  await initCore(db);
  const states: BackupTableSummary[] = [];
  for (const { name } of await restorableTables(db)) {
    const columns = new Set((await db.all(`PRAGMA table_info(${qident(name)})`)).map(c => String(c.name).toLowerCase()));
    const row = (await db.all(`SELECT count(*) AS n, ${columns.has('deleted_at') ? 'sum(deleted_at IS NULL)' : 'count(*)'} AS live, ${columns.has('updated_at') ? 'max(updated_at)' : 'NULL'} AS newest FROM ${qident(name)}`))[0]!;
    states.push({ table: name, rows: Number(row.n), liveRows: Number(row.live ?? 0), newestUpdatedAt: typeof row.newest === 'string' ? row.newest : null });
  }
  const log = (await db.all('SELECT count(*) AS n FROM _schema_log'))[0]!;
  return summarize(states, Number(log.n));
}

async function restorableTables(db: SqlDriver): Promise<{ name: string; sql: string }[]> {
  return (await db.all("SELECT name, sql FROM main.sqlite_master WHERE type='table' AND sql IS NOT NULL AND substr(name,1,1) != '_' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name"))
    .map(r => ({ name: String(r.name), sql: String(r.sql) }));
}

export async function previewRestore(db: SqlDriver, source: DumpSource): Promise<RestorePreview> {
  await initCore(db);
  await assertCoreReplica(db);
  const backup = await validateBackup(source);
  const current = await replicaSummary(db);
  return { backup, current };
}

/** The portable SQL dump of `life export`: the replica's schema log and every
 * ordinary table with its rows, then indexes, triggers and views. Device sync
 * state, caches and other underscore plumbing stay out. */
export async function exportReplica(db: SqlDriver, sink: DumpSink): Promise<BackupSummary> {
  await initCore(db);
  const write = (text: string) => sink.write(text);
  const states: BackupTableSummary[] = [];
  let schemaEntries = 0;
  await write(`${DUMP_HEADER}\nBEGIN TRANSACTION;\n`);
  const log = (await db.all("SELECT sql FROM main.sqlite_master WHERE type='table' AND name='_schema_log'"))[0]!;
  for (const table of [{ name: '_schema_log', sql: String(log.sql) }, ...await restorableTables(db)]) {
    await write(`${table.sql};\n`);
    const info = await db.all(`PRAGMA table_info(${qident(table.name)})`);
    const columns = info.map(c => String(c.name));
    const lower = columns.map(c => c.toLowerCase());
    const prefix = `'INSERT INTO ${qident(table.name).replaceAll("'", "''")} (${columns.map(qident).join(',').replaceAll("'", "''")}) VALUES('`;
    const statement = `${prefix} || ${columns.map(c => `quote(${qident(c)})`).join(" || ',' || ")} || ');'`;
    const state = { table: table.name, rows: 0, liveRows: 0, newestUpdatedAt: null as string | null };
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(table.sql);
    const extra = `${lower.includes('deleted_at') ? `${qident(columns[lower.indexOf('deleted_at')]!)} IS NULL` : '1'} AS live, ${lower.includes('updated_at') ? qident(columns[lower.indexOf('updated_at')]!) : 'NULL'} AS stamp`;
    for (let after: unknown = null, offset = 0; ;) {
      // ponytail: WITHOUT ROWID tables page by OFFSET; no estate table has one.
      const page = rowid
        ? await db.all(`SELECT rowid AS r, ${statement} AS s, ${extra} FROM ${qident(table.name)}${after === null ? '' : ' WHERE rowid > ?'} ORDER BY rowid LIMIT 500`, after === null ? [] : [after as number])
        : await db.all(`SELECT ${statement} AS s, ${extra} FROM ${qident(table.name)} LIMIT 500 OFFSET ?`, [offset]);
      if (!page.length) break;
      await write(page.map(r => r.s).join('\n') + '\n');
      for (const r of page) {
        if (r.live) state.liveRows++;
        if (typeof r.stamp === 'string' && (state.newestUpdatedAt === null || r.stamp > state.newestUpdatedAt)) state.newestUpdatedAt = r.stamp;
      }
      state.rows += page.length;
      after = page.at(-1)!.r ?? null;
      offset += page.length;
    }
    if (table.name === '_schema_log') schemaEntries = state.rows;
    else states.push(state);
  }
  const names = new Set((await restorableTables(db)).map(t => t.name.toLowerCase()));
  const objects = await db.all("SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY CASE type WHEN 'index' THEN 0 WHEN 'trigger' THEN 1 ELSE 2 END, name");
  for (const o of objects) {
    if (ignoredName(String(o.name)) || (o.type !== 'view' && !names.has(String(o.tbl_name).toLowerCase()))) continue;
    await write(`${o.sql};\n`);
  }
  await write('COMMIT;\n');
  await sink.close();
  return summarize(states, schemaEntries);
}

/** A Python-synced file keeps its own checkpoints; the CLI owns its restore. */
async function assertCoreReplica(db: SqlDriver): Promise<void> {
  if ((await db.all("SELECT 1 FROM _sync_state WHERE key IN ('last_push','last_pull') LIMIT 1")).length) {
    throw new Error('This database is synced by the Life CLI. Restore it with the CLI instead.');
  }
}

/** Replaces every ordinary table, its rows and the schema log with the backup's,
 * in one transaction, after writing a recovery dump of the current replica.
 * Device sync state resets, so the next sync pulls everything and pushes every
 * restored row: newer hub revisions still win, rows the hub lacks reach it. */
export async function restoreReplica(db: SqlDriver, files: BackupFiles, args: RestoreArgs): Promise<RestoreResult> {
  if (!args || args.confirm !== 'replace' || typeof args.file !== 'string' || typeof args.recovery !== 'string' || !args.file || !args.recovery || args.file === args.recovery) {
    throw new Error('Restoring requires the backup, a separate recovery file and the typed confirmation "replace".');
  }
  await initCore(db);
  await assertCoreReplica(db);
  const expected = await readDump(files.open(args.file));
  const recovery = await exportReplica(db, files.create(args.recovery));
  const restored = await db.transaction(async () => {
    await assertCoreReplica(db);
    // Hosts may enforce declared foreign keys; the dump is consistent only as a whole.
    await db.run('PRAGMA defer_foreign_keys = ON');
    const objects = await db.all("SELECT type, name FROM main.sqlite_master WHERE type IN ('view','table') AND substr(name,1,1) != '_' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type DESC");
    for (const o of objects) await db.run(`DROP ${o.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${qident(String(o.name))}`);
    await db.run('DELETE FROM _schema_log');
    const read = await readDump(files.open(args.file), {
      table: async (_name, sql) => { await db.run(sql); },
      rows: async (table, columns, tuples) => {
        await db.run(`INSERT INTO ${qident(table)} (${columns.map(qident).join(',')}) VALUES ${tuples.join(',')}`);
      },
      ddl: async sql => { await db.run(sql); },
    });
    if (read.characters !== expected.characters || JSON.stringify(read.summary) !== JSON.stringify(expected.summary)) {
      throw invalid('The backup changed while it was being restored. Nothing was replaced.');
    }
    for (const table of ['_core_sync', '_core_pending', '_core_rejected', '_core_history_hold', '_core_coverage', '_core_pull_progress']) await db.run(`DELETE FROM ${table}`);
    await db.run("DELETE FROM _core_state WHERE key IN ('last_sync','skipped_tables')");
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('coverage_phase','refreshing')");
    const search = (await db.all("SELECT name FROM main.sqlite_master WHERE type='table' AND name IN ('_core_search_fts','_core_search_docs','_core_search_dirty','_core_search_state')")).map(r => String(r.name));
    for (const table of search) await db.run(`DELETE FROM ${table}`);
    return read.summary;
  });
  return { restored, recovery };
}

// --- hub backups ---------------------------------------------------------------

const HUB_KEY = /^(?:daily|weekly|monthly|yearly|manual)\/[a-z][a-z0-9-]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql\.gz$/;
function hubBackup(b: unknown): b is HubBackup {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const r = b as Row;
  return typeof r.key === 'string' && HUB_KEY.test(r.key) && validEditTimestamp(r.taken_at)
    && typeof r.bytes === 'number' && Number.isSafeInteger(r.bytes) && r.bytes >= 0
    && (r.sha256 === null || (typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)));
}
export const hubBackupRoute = (key: string) => {
  if (!HUB_KEY.test(key)) throw new Error('invalid hub backup key');
  return `/v1/backups/${key}`;
};

export async function listHubBackups(hub: ServiceHub): Promise<HubBackupList> {
  const { data } = await hub.get('/v1/backups');
  const backups = (data as Row | null)?.backups;
  if (!Array.isArray(backups) || !backups.every(hubBackup)) throw new Error('invalid hub backups response');
  return { backups: backups.map(({ key, taken_at, bytes, sha256 }) => ({ key, taken_at, bytes, sha256 })) };
}

export async function createHubBackup(hub: ServiceHub): Promise<HubBackup> {
  const { data } = await hub.post('/v1/backups', {});
  const backup = (data as Row | null)?.backup;
  if (!hubBackup(backup)) throw new Error('invalid hub backup response');
  const { key, taken_at, bytes, sha256 } = backup;
  return { key, taken_at, bytes, sha256 };
}
