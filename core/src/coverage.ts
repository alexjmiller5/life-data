import type { SqlDriver } from './driver.ts';
import type { Row } from './validate.ts';

// Local certificates, never sync rows or an inference from a legacy cursor.
// v1 certifies a complete unfiltered pull followed by successful incremental
// walks. It says nothing about simultaneous remote snapshots or freshness.
export const COVERAGE_VERSION = 1;
export async function initCoverage(db: SqlDriver): Promise<void> {
  await db.run('CREATE TABLE IF NOT EXISTS _core_coverage (tbl TEXT PRIMARY KEY, endpoint TEXT NOT NULL, schema TEXT NOT NULL, pull TEXT NOT NULL, version INTEGER NOT NULL)');
}

export async function coverageSchema(db: SqlDriver): Promise<{ tables: string[]; signature: string }> {
  const schema = await db.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE substr(name,1,1) != '_' AND substr(name,1,7) != 'sqlite_' ORDER BY type,name");
  // Logged drop/recreate cycles can leave the same physical SQL. Internal
  // search/cache DDL is deliberately absent from both pieces of this identity.
  const log = await db.all('SELECT count(*) AS count,coalesce(max(id),0) AS last FROM main._schema_log');
  // Drivers may reconstruct row objects in any key order (including native
  // JSON bridges). Only ordered SQL rows and explicit field tuples identify it.
  return { tables: schema.filter(r => r.type === 'table').map(r => String(r.name)),
    signature: JSON.stringify([schema.map(r => [r.type,r.name,r.tbl_name,r.sql]),[log[0].count,log[0].last]]) };
}

export function validCoverage(proof: Row | undefined, endpoint: string, signature: string, pull: unknown): boolean {
  return !!proof && proof.version === COVERAGE_VERSION && proof.endpoint === endpoint
    && proof.schema === signature && proof.pull === pull;
}

/** Read-only, transaction-scoped check. Missing metadata never grants trust. */
export async function coverageProblem(db: SqlDriver): Promise<string | null> {
  const names = new Set((await db.all("SELECT name FROM main.sqlite_master WHERE type='table'")).map(r => r.name));
  if (['_core_state','_sync_state','_core_sync','_core_coverage','_schema_log'].some(t => !names.has(t))) {
    return 'Global schema coverage is unverified. Complete an unfiltered sync of every table, including history and provenance, or use the CLI writer.';
  }
  const state = new Map((await db.all('SELECT key,value FROM main._core_state')).map(r => [r.key,r.value]));
  const endpoint = state.get('hub');
  const cli = (await db.all("SELECT value FROM main._sync_state WHERE key='hub_url'"))[0]?.value;
  if (typeof endpoint !== 'string' || !endpoint || cli !== endpoint || state.get('coverage_phase') !== 'ready') {
    return 'Global schema coverage is unverified or a sync is incomplete. Finish a full sync of every table before invariant-checked writes, or use the CLI writer; unbound/imported files are not assumed complete.';
  }
  const { tables, signature } = await coverageSchema(db);
  const proofs = new Map((await db.all('SELECT * FROM main._core_coverage')).map(r => [r.tbl,r]));
  const cursors = new Map((await db.all('SELECT tbl,pull FROM main._core_sync')).map(r => [r.tbl,r.pull]));
  const missing = tables.filter(t => !validCoverage(proofs.get(t),endpoint,signature,cursors.get(t)));
  return missing.length ? `Invariant checks require full coverage of every global schema table, including history/provenance. Include and fully sync: ${missing.join(', ')}. Coverage is not a current or simultaneous remote snapshot.` : null;
}
