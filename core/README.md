# life-core

Shared TypeScript behavior for browser and JavaScriptCore clients. Runtime
source imports no platform modules. Inject a `SqlDriver` and a `Hub`.

- `sync(driver, hub, options)` replays schema, snapshots writes, pulls pages,
  pushes pending revisions and records rejected edits in `_core_rejected`.
  Cursors in `_core_sync` are per table and deliberately independent of the
  Python client's global checkpoints. The endpoint is bound before replay.
- `maxRows` defaults to 50,000 rows. Catalog tables always sync. Set
  `tables: { table_name: true }` to include a large table, or `false` to exclude
  one. Overrides change replication only; retained local rows are not deleted.
- `writeRow(driver, table, patch)` creates when `id` is omitted and edits when
  an existing `id` is supplied. Use `deleted_at: true` for trash and `null` for
  restore. Defaults, validation, timestamps and original cell history commit
  together. Pass `expectedUpdatedAt` in write options from the opened record
  to reject stale edits. Components must not write raw SQL. `isReadOnlyTable`
  recognizes built-in system tables and catalog entries with `kind: system`.
- Each successful `writeRow` also commits a `_core_pending` marker for that
  table, row and revision. Repeated edits coalesce into one pending row.
  An accepted sync receipt clears only markers at or below its submitted
  revision; newer concurrent edits, rejections and lost receipts stay pending.
- `syncStatus(driver)` returns `{ lastSuccessfulSync, pendingUiEdits, rejected }`
  from local durable state. The timestamp is the last successful core round's
  checkpoint, or `null`. Counts are pending UI-written rows and rows in the
  rejection inbox. Pending UI edits await this core's own valid receipt even
  if Python has already pushed them; this is not the entire CLI sync queue.
- `readCatalog` decodes properties. `compileView` produces parameterized,
  catalog-scoped SQL with filtering, sorting, literal search and bounded pages.
- `createHttpHub(endpoint, token, fetch)` is the browser transport. The native
  host supplies a `Hub` using URLSession. Neither credentials nor SQL drivers
  are owned by the core. HTTP adapters must expose the server Date header and
  impose a request timeout. Clock skew above five minutes blocks pushes.
- `ServiceHub` extends `Hub` with `get(route)`. `createHttpHub` implements both;
  native hosts provide the same HTTPS/loopback, no-redirect, no-cookie behavior.
  `readUsage` returns the deployment's `UsageSummary`, preserving unmeasured
  values as `null`. `readNotifications` walks the complete ascending feed from
  zero each time to reconcile shared read state. Invalid pagination, failed
  requests and the 1,000-page bound throw without returning a partial feed.
  `markNotificationsRead(hub, { ids?, through? })` marks explicit IDs and/or
  all sequences up to and including `through`, returning `{ unread_count }`.
- `notificationPresentation(feed, previousBaseline)` returns
  `{ notifications, baseline }`. A `null` baseline suppresses history and uses
  `latest_cursor`; later calls select unread notifications above the baseline,
  deduplicate by stable ID, and advance only through collected sequences.
  Hosts own permissions, timers and persistence per canonical endpoint, and
  save the proposed baseline only after successful presentation. Unknown
  notification producers/types and their JSON data remain supported.

`SqlDriver.transaction` must serialize other callers through commit/rollback.
The browser host must exclude overlapping rounds across tabs with a Web Lock.
A native host sharing a Python replica must hold `<database>.sync.lock` around
sync. The core additionally refuses overlap on one driver instance.

Current limits: enforced SQL invariants and custom triggers fail closed in
`writeRow` until the complete validation/journaling engine is integrated. Only
the CLI's canonical timestamp triggers are supported. Missing local references require their
table to be included and synced. Skipped tables have no remote browsing API in
this package yet. Sync snapshots pending rows in memory; very large full
replicas will need snapshots staged in temporary tables. Search is a bounded
SQL scan, not an FTS index. Saved-view storage, enrollment and native contract
generation are client integration work.

Run `bun test` and `bun run check` here, or `just test` / `just check` at the
repository root. The shared `tests/fixtures/sync-protocol/revisions.json` cases
run in both Python and TypeScript; core tests also call the actual Worker over
its D1-compatible SQLite test adapter. No live dataset is needed.
