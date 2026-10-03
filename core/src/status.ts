import type { SqlDriver } from './driver.ts';
import { initCore } from './sync.ts';

import type { SyncStatus } from './contract.generated.ts';
export type { SyncStatus } from './contract.generated.ts';

export async function syncStatus(db: SqlDriver): Promise<SyncStatus> {
  await initCore(db);
  // One SQLite statement gives all fields the same committed snapshot.
  const row = (await db.all(`SELECT
    (SELECT value FROM _core_state WHERE key='last_sync') AS last_sync,
    (SELECT value FROM _core_state WHERE key='skipped_tables') AS skipped_tables,
    (SELECT count(*) FROM _core_pending) AS pending,
    (SELECT count(*) FROM _core_rejected) AS rejected`))[0]!;
  let skippedTables: unknown = [];
  try {
    if (row.skipped_tables != null) skippedTables = JSON.parse(String(row.skipped_tables));
    if (!Array.isArray(skippedTables) || skippedTables.some(t => typeof t !== 'string' || !t.length)
      || new Set(skippedTables).size !== skippedTables.length) throw new Error();
  } catch {
    throw new Error('Invalid saved skipped-table status; complete a successful sync to refresh it.');
  }
  return {
    lastSuccessfulSync: row.last_sync == null ? null : String(row.last_sync),
    pendingUiEdits: Number(row.pending),
    rejected: Number(row.rejected),
    skippedTables: skippedTables as string[],
  };
}
