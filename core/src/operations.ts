import type { CoreHandlers, OptionsArgs, View, WorkspaceRow } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import type { ServiceHub } from './services.ts';
import { readCatalog } from './catalog.ts';
import { referenceSources, referencedBy } from './references.ts';
import { allowed } from './validate.ts';
import { compileView, displayName } from './view.ts';
import { isReadOnlyTable, writeability } from './write.ts';
import { createWriteSession } from './undo.ts';
import { enrollmentApproval, validateDeviceSession, enrollmentPollResult, sessionRevocationResult } from './enrollment.ts';
import { sync } from './sync.ts';
import { syncStatus } from './status.ts';
import { readRejections } from './rejections.ts';
import { prepareSearch, search } from './search.ts';
import { readRemoteRows, readRemoteRow } from './remote.ts';
import { listViews, saveView, deleteView } from './saved-views.ts';
import { readUsage, readNotifications, markNotificationsRead, notificationPresentation } from './services.ts';

/** Shared queries; hosts own serialization, read-only SQL enforcement and locks. */
export async function readRows(db: SqlDriver, view: View): Promise<WorkspaceRow[]> {
  const read = async () => {
    const catalog = await readCatalog(db);
    const table = catalog.tables.find(t => t.id === view.table);
    if (!table) throw new Error('Table is not in the catalog');
    const query = compileView(view, catalog.properties);
    if (view.search) await prepareSearch(db, catalog);
    const rows = await db.all(query.sql, query.params);
    return rows.map(record => ({ record, label: displayName(record, typeof table.display === 'string' ? table.display : undefined) }));
  };
  return view.search ? db.transaction(read) : read();
}

export async function readOptions(db: SqlDriver, { table, column }: OptionsArgs): Promise<string[]> {
  const catalog = await readCatalog(db);
  const property = catalog.properties.find(p => p.tbl === table && p.col === column);
  if (!property || !['select', 'multi_select'].includes(property.type ?? '')) throw new Error('Select property is not in the catalog');
  const rows = property.options_sql ? await db.all(`SELECT * FROM (${property.options_sql})`) : [];
  const extra = rows.map(row => Object.values(row)[0] as string);
  return allowed(property, () => extra);
}

/** Typed local dispatch, not a network protocol. Credentials stay in the host. */
export function createCoreHandlers(db: SqlDriver, hub: (endpoint: string) => ServiceHub, origin = 'local'): CoreHandlers {
  const writes = createWriteSession(db, origin);
  return {
    enrollmentApproval,
    validateDeviceSession: ({ data }) => validateDeviceSession(data),
    enrollmentPollResult: ({ reply, expectedFingerprint }) => enrollmentPollResult(reply, expectedFingerprint),
    sessionRevocationResult,
    async catalog() {
      const catalog = await readCatalog(db);
      return { ...catalog, tables: catalog.tables.map(t => ({ ...t, readOnly: isReadOnlyTable(String(t.id), t) })) };
    },
    rows: view => readRows(db, view),
    referenceSources: args => referenceSources(db, args),
    referencedBy: args => referencedBy(db, args),
    remoteRows: ({ endpoint, ...args }) => readRemoteRows(db, hub(endpoint), args),
    remoteRow: ({ endpoint, ...args }) => readRemoteRow(db, hub(endpoint), args),
    search: args => search(db, args),
    listViews: args => listViews(db, args),
    saveView: args => writes.otherMutation(args, input => saveView(db, input, { origin })),
    deleteView: args => writes.otherMutation(args, input => deleteView(db, input, { origin })),
    options: args => readOptions(db, args),
    write: writes.write,
    undo: writes.undo,
    undoStatus: writes.undoStatus,
    writeability: args => writeability(db, args),
    status: () => syncStatus(db),
    rejections: args => readRejections(db, args),
    sync: args => sync(db, hub(args.endpoint), { maxRows: args.maxRows, tables: args.tables }),
    serviceUsage: args => readUsage(hub(args.endpoint)),
    serviceNotifications: args => readNotifications(hub(args.endpoint)),
    markNotificationsRead: args => markNotificationsRead(hub(args.endpoint), args.selector),
    notificationPresentation: args => notificationPresentation(args.feed, args.baseline),
  };
}
