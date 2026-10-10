import { Database } from 'bun:sqlite';
import type { Hub, SqlDriver, Value } from '../src/driver.ts';
import { searchIndexStep } from '../src/search.ts';
// @ts-ignore The production Worker is JavaScript, exercised through its real HTTP interface.
import worker from '../../worker/src/index.js';
// @ts-ignore Existing D1-compatible SQLite test adapter.
import { D1Shim } from '../../worker/test/d1shim.js';

/** Runs the search index step to completion, as hosts do after rounds and writes. */
export async function indexSearch(db: SqlDriver) { while (!(await searchIndexStep(db, { budgetMs: 60_000 })).done); }

export const T0 = '2026-01-01T00:00:00.000Z';
export const T1 = '2026-01-02T00:00:00.000Z';
export const T2 = '2026-01-03T00:00:00.000Z';
export class TestSql implements SqlDriver {
  db = new Database(':memory:');
  async all(sql: string, params: Value[] = []) { return this.db.query(sql).all(...params) as Record<string, unknown>[]; }
  async run(sql: string, params: Value[] = []) { return this.db.query(sql).run(...params).changes; }
  async transaction<T>(body: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = await body(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
export const schema = [
  'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, qty INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)',
  'CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, type TEXT, required INTEGER, sort INTEGER, options TEXT, inputs TEXT, default_value TEXT, options_sql TEXT, ref_table TEXT, derived_by TEXT, immutable INTEGER, deprecated INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)',
  'CREATE TABLE catalog_rules (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, kind TEXT, enforce INTEGER, sql TEXT, text TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)',
  'CREATE TABLE history (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)',
];
// Most tests intercept single-table pulls; `batch` lets the hub advertise and
// answer many-page requests as deployed.
export function setup({ batch = false } = {}) {
  const db = new TestSql();
  const remote = new D1Shim();
  remote.db.exec('CREATE TABLE _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT, ddl TEXT)');
  for (const ddl of schema) {
    remote.db.exec(ddl);
    remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  }
  const requests: { route: string; body: any }[] = [];
  const hub: Hub = { endpoint: 'https://hub.test', async post(route, body) {
    requests.push({route,body});
    const response = await worker.fetch(new Request('https://hub.test'+route, {
      method:'POST',headers:{Authorization:'Bearer fixture', 'Content-Type':'application/json'},body:JSON.stringify(body),
    }), { DB:remote,HUB_TOKEN:'fixture' }, {waitUntil() {}});
    if (!response.ok) throw new Error(`hub HTTP ${response.status}`);
    const data = await response.json();
    if (!batch && route === '/v1/cursor') delete data.pull_batch;
    return {data,date:new Date().toUTCString()};
  }};
  return {db,remote,hub,requests};
}
