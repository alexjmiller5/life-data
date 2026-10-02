import type { SqlDriver } from './driver.ts';
import { initCore } from './sync.ts';

import type { SyncStatus } from './contract.generated.ts';
export type { SyncStatus } from './contract.generated.ts';

export async function syncStatus(db: SqlDriver): Promise<SyncStatus> {
  await initCore(db);
  // One SQLite statement gives all three fields the same committed snapshot.
  const row = (await db.all(`SELECT
    (SELECT value FROM _core_state WHERE key='last_sync') AS last_sync,
    (SELECT count(*) FROM _core_pending) AS pending,
    (SELECT count(*) FROM _core_rejected) AS rejected`))[0]!;
  return {
    lastSuccessfulSync: row.last_sync == null ? null : String(row.last_sync),
    pendingUiEdits: Number(row.pending),
    rejected: Number(row.rejected),
  };
}
