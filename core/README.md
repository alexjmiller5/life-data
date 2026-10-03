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
  catalog-scoped SQL with filtering, sorting and bounded pages. `contains`
  remains a literal substring filter (or exact JSON array membership).
- `listViews(driver, { table, trash? })` reads shared saved definitions and
  returns `{ views, unavailable }`. Each record carries `id`, `name`, `tbl`,
  `updated_at`, `deleted_at`, `definition`, `view` and `unavailable`. Malformed
  definitions, unknown versions, missing tables and removed columns disable
  that record without failing the whole list or modifying stored data.
- `saveView(driver, { table, name, definition, id?, expectedUpdatedAt? })`
  creates or edits through `writeRow`; an existing ID requires its selected
  revision. `deleteView(driver, { id, expectedUpdatedAt })` tombstones without
  requiring a readable definition. Both retain normal write restrictions,
  validation, history, pending markers and stale-edit rollback. Deletes still
  require matching storage and a valid revision. Missing/colliding storage is
  a setup error; core never provisions, adopts or repairs it automatically.
- Saved definitions are `{ version: 1, columns?, filters?, sort?, search?,
  trash?, widths? }`. Columns must be distinct; widths map known columns to
  positive finite numbers. Filters/sorting/search use the existing core view
  compiler. No table name, pagination, default selection or private device
  preferences are stored in the JSON. The default remains a transient
  All records view using catalog columns.
- **`definition.columns` becomes SQL projection in the returned `view`.** It
  can omit `id`, `updated_at` and hidden fields. For visual layout only, omit
  `columns` when calling `rows`; otherwise fetch a full row by ID before
  editing. Never populate a full-record editor from a partial grid row.
- `search(driver, { text, table?, limit?, offset? })` searches the local replica
  with FTS5 and returns `{ table, id, label, excerpt }[]`. `View.search` uses
  the same index before filtering, sorting and paging. Search ANDs literal
  word prefixes, folds case/accents with `unicode61`, and does not accept FTS
  operators. It is word search, not arbitrary substring matching. Empty or
  punctuation-only global searches return no hits. Limits default to 50 and
  cap at 200; queries are limited to 4096 characters / 64 words. Global hits
  rank by BM25 with table/id tie-breakers and exclude trash; row views retain
  their explicit sorting and trash selection.
- Search indexes physically present, cataloged textual columns, including raw
  Markdown, select, URL, email, phone, ref, date and datetime values. It does
  not search uncataloged fields, JSON, numbers, blobs, or remote skipped data.
  Retained rows from skipped tables are still local results and may be stale:
  hosts must keep sync coverage warnings visible. No result is a claim of
  complete hub coverage. Labels use the shared display-name function.
- Excerpts use up to 24 FTS tokens, capped at 512 SQLite characters, with
  conservative cleanup of Markdown headings, lists, links and inline markers.
  Link destinations, code and table text remain searchable. This is **raw
  Markdown indexing plus display cleanup**, not a maintained plain-text
  projection or a Markdown renderer. Render excerpts as plain text, never HTML.
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

SQLite must support **FTS5 with the unicode61 tokenizer**. Hosts may call
`assertSearchSupport(driver)` at database open for an explicit capability error;
search also checks on use and never silently falls back to a table scan. The
probe creates only local cache tables. Browser hosts need an FTS5-enabled WASM
artifact and must verify FTS reads through their read-only SQL adapter. Native
hosts verify the actual GRDB/JSC connection, not a separate CLI SQLite binary.

The search cache uses `_core_search_fts`, `_core_search_docs`,
`_core_search_dirty` and `_core_search_state`. Queue-only persistent triggers
record OLD/NEW IDs in the same transaction as writes, including pulls and
independent Python writes. They invoke no FTS functions in those writers.
Before searching, core reconciles catalog/schema fingerprints, drains dirty
rows in batches, and reads results under one BEGIN IMMEDIATE transaction.
Queued IDs and actual returned IDs are both replaced in the binary-keyed
cache, so source collations such as NOCASE cannot collide across batches.
Failed drains roll back and retain their queue; missing cache components or
triggers cause a rebuild. Dropped/renamed tables and catalog changes purge or
rebuild affected entries. None of this local DDL is logged or synced, and cache
work does not create history, pending UI edits or revisions on source rows.

Clean searches read metadata and the FTS index, not source table contents.
Initial backfills and schema changes scan affected tables. A dirty table with
UNIQUE constraints or custom collation also gets an indexed ID anti-join to
remove silent `INSERT/UPDATE OR REPLACE` victims when SQLite delete triggers
are disabled. Other edits read only queued IDs. Use `readRows` for searched
views; callers using `compileView` directly must first call `prepareSearch`
inside the same driver transaction as the query.

`writeRow` supports deterministic, table-scoped enforced SQL invariants after
verified replication coverage. `before` contains the selected row before an
edit (empty for inserts); `changed` is its actual SQLite snapshot/`EXCEPT`
difference, and `now.ts` is captured once. Both row contexts have the table's
exact shape, with no bookkeeping columns. Checks run before history/pending
edits commit, including for tombstones. Only the affected table's rules run,
matching Python's single-row write and Worker OLD/NEW contexts. This does not
make multi-row Python mutations or cross-table cascades replayable as one
atomic sync operation. `tests/fixtures/table-invariants.json` exercises Python
and core origins through their real hub implementations and second replicas.

Rules must be deterministic over their declared data and captured `now.ts`.
The shared core/Worker SQL text screen and Python parity fixture reject the
date/time function family (including safe explicit-input calls), CURRENT_DATE,
CURRENT_TIME, CURRENT_TIMESTAMP, randomness and connection-state functions.
Compare or slice `now.ts` directly, for example `substr((SELECT ts FROM now),1,10)`.
This conservative screen can reject matching text in comments/literals; it is
not a SQL parser or proof about indirect reads through views, custom functions
or data-dependent SQL. Those dependencies remain the rule author's contract.
Catalog defaults are separate and retain their existing behavior.

The durable `_core_coverage` certificates belong to sync, not UI preferences.
They certify an unfiltered full pull and subsequent successful incremental
walks for one endpoint, public schema/log identity, checkpoint and version.
Ordinary cursors, row counts and Python daemon acknowledgements never grant
proof. Missing/stale proof forces a full backfill; skipped tables invalidate
their proof. A durable refresh flag blocks invariant writes across failures
and restarts until recovery completes. Certificates and readiness commit with
sync checkpoints; none of this local metadata is logged or synced.

Invariant-checked writes require coverage of the target, validation catalogs,
declared reference tables and all compiler-reported rule/options/default reads.
History/provenance need proof when validation reads them, not just because the
writer appends history. Ordinary tables without enforced invariants keep their
existing write behavior; references alone do not activate this coverage gate.
Adapters without `readDependencies` conservatively require coverage of
**every table in the global schema, including history/provenance**.
Unbound or externally imported files are not assumed complete. Coverage is
not freshness, a simultaneous remote snapshot, or a guarantee of hub acceptance.
The hub rechecks its own state; rejection retains the local pending edit and
history. There are no scoped replication assumptions or new hub endpoints.

`writeability(db, { table })` returns `{ writable, reason: WriteViolation | null }`.
It is an advisory over the same table guards as `writeRow`, with no persistent
changes; a successful
answer does not approve a patch or selected revision. The writer rechecks
inside its transaction. Reasons include `coverage`, `trigger`, `foreign_key`,
`invariant`, `context`, `schema` and `read_only`; UI can display `reason.message` directly.

### Compiler read metadata

The optional `SqlDriver` method is a trusted host seam, not a client RPC:

```ts
readDependencies?(
  statements: readonly SqlReadStatement[], // { sql: string; params?: Value[] }
  context: SqlReadContext,                // { ownedTempTables: readonly string[] }
): Promise<{ tables: string[] } | null>;
```

Prepare each input as a fresh single read-only statement on the transaction's
actual connection, without stepping it. Return a conservative union of ordinary
`main` table names, using canonical schema spelling and expanding SQL views to
their underlying reads. Use SQLite compiler read metadata, never SQL text parsing
or a persistent dependency cache. `null` means the complete set cannot be
established and blocks the write even if global coverage exists. Preparation
errors and malformed results also block; they never mean an empty read set.
An absent method retains the global gate. Only a verified empty read set returns
`{ tables: [] }`; core still requires target/catalog/reference proofs.

Core calls this method only for invariant-checked tables, within their existing
transaction. The batch contains every applicable invariant's actual runtime SQL
wrapper plus all SQL defaults/options for that table, even when an individual
patch might not use one. Invariant parameters are inspection placeholders; they
must not be evaluated. The same wrapper builds the executed `changed`/`before`
SQLite snapshot/EXCEPT contexts and captured `now.ts`.

Core first rejects any pre-existing TEMP object named `_core_write_before`, then
creates its own empty schema-shaped `temp._core_write_before`. Only after CREATE
succeeds does it pass `ownedTempTables: ['_core_write_before']`. The supplied list
is a trusted ownership assertion, never permission inferred from a SQL name.
The adapter verifies that the claimed TEMP tables exist as ordinary tables and
that there are no unrelated TEMP objects or conflicting main names. Core drops
only its owned snapshot in a finally block. Transaction rollback also removes
it on failure. The actual mutation later takes its separate selected-row snapshot;
advisory preparation never copies or changes user rows. Neither snapshot is logged
or persisted. Physical TEMP tables named `changed`, `before` or `now` are not
engine contexts and must not be trusted.

For wa-sqlite, collect `SQLITE_READ` inside the existing authorizer without
weakening its read-only policy. Count/EXISTS reads can have an empty database
qualifier: resolve them only against a verified unambiguous schema inventory.
For GRDB, retain its authorizer and use `Statement.databaseRegion` plus public
region membership/union/equality APIs. GRDB drops database qualifiers; reject
attached schemas and unowned TEMP objects before narrowing. Account for every
region element, not just matches found while enumerating known tables. Never
parse `DatabaseRegion.description` or inspect its private dictionary.

Known engine CTE pseudo-reads (`changed`, `before`, `now`) and built-in
`json_each`/`json_tree` iterators can be nonpersistent. Their underlying ordinary
table reads still count. A real main table with one of those names must not be
exempted. Unexplained CTE reads, virtual/shadow table dependencies, introspection
table functions, engine bookkeeping reads and ambiguous namespaces return null.
Reject unsupported dependencies, not merely the existence of unrelated virtual
tables such as the local FTS cache. A host with custom functions/modules that
perform opaque database reads cannot certify this capability until those reads
are accounted for; extension loading stays prohibited.

Core enforces `READ_DEPENDENCY_LIMITS`: 128 statements, 524,288 UTF-16 code units
of total SQL (`String.length`, Swift `utf16.count`), and 4,096 returned tables.
Hosts may rely on those trusted-caller limits. Discovery must prepare SQL and
read schema metadata only, never scan user rows. Dependency sets are recomputed
inside each advisory/write transaction. Durable proof, endpoint, schema and
refresh invalidations remain owned by `_core_coverage` and sync.

`tests/fixtures/read-dependencies.json` is the shared host conformance fixture:
fresh synthetic setup per case, then case setup, statements and ownership context.
Compare sorted table sets, null for unsupported inputs, or a thrown error for
invalid/non-read-only inputs. Its expression-error case must succeed at inspection
without executing the expression. Core tests inject the host metadata seam while
preparing real SQL; Python checks supported fixture sets with SQLite's authorizer.
Browser and native tests must run the fixture on their actual shipped adapters.
Bun's SQLite adapter lacks a public compiler-read hook and exercises the legacy
global fallback; no private Bun API or second vendored WASM is required.

Custom triggers and enforced estate rules remain blocked. Only the CLI's exact
timestamp triggers and core queue-only search triggers are supported. Every
declared SQLite foreign key anywhere in main/temp blocks writes, including
NO ACTION/RESTRICT: host enforcement differs, and cascade effects are not
journaled. Catalog `ref`/`multi_ref` validation continues normally. Adapters
must permit read-only
`PRAGMA main.foreign_key_list(...)` and `PRAGMA temp.foreign_key_list(...)`;
failure to inspect blocks the write. `INSERT/UPDATE OR ABORT` prevent implicit
REPLACE deletions, so the guarded writer changes one primary-key identity.

Guard work reads schema/catalog/certificate metadata and one FK list per
physical table. The before snapshot holds at most one row, and each invariant
returns at most one violation. Rule SQL can still scan large tables or joins;
this does not impose a CPU deadline or bounded SQL execution cost. No host
timer, progress-handler API, or whole-table JS snapshot is introduced.
Missing local references require their table to be included and synced.
Skipped tables have no remote browsing API here. Sync snapshots pending rows
in memory; very large full replicas will need snapshots staged in temporary
tables. Enrollment remains a host integration.

Shared saved-view storage is an ordinary synced `views` table, with
`name:text!`, `tbl:ref!` (to `catalog_tables`) and `definition:json!`, plus the
standard ID/timestamp/tombstone/hub columns and canonical timestamp trigger.
The catalog table entry has `kind=table`, `display=name`. Property
`views.definition` carries `source=life-core`, `source_ref=saved-views/v1`:
this marker identifies the schema, never actual view definitions. All
definitions live exclusively in `views` rows. Names need not be unique.

An operator uses an existing replica and the supported logged-DDL workflow.
First sync with full schema scope and inspect the physical `sqlite_master`
entry through `life sql`, plus `life doc views` if the name already exists. Stop on a collision or any failed
step; an existing unrelated `views` table must never be silently adopted,
dropped or renamed. For absent storage only:

```sh
life sync
life table create views 'name:text!' 'tbl:ref!' 'definition:json!'
life property set views.tbl --ref-table catalog_tables
life table set views --kind table --display name --purpose 'Shared named table views'
life property set views.definition --source life-core --source-ref saved-views/v1
life doc views
life sync
```

Set the marker last, after reviewing the schema and property metadata.
Ordinary clients receive this existing logged DDL and catalog through sync;
they need no schema provisioning rights. Include `tables: { views: true }`
when enabling saved views so the size threshold does not hide definitions.
This does not imply that every referenced target table is fully replicated.
`life table rename` updates `views.tbl` only for the exact recognized schema
and marker, with ordinary validation/history in the rename transaction.
Column renames/removals leave affected definitions unavailable for explicit
repair; unknown JSON versions are never rewritten.

`schema/saved-views.json` is the canonical storage manifest: ordered `ddl`, one
`table` catalog seed, and `properties` catalog seeds. Core recognition reads
the DDL and identity metadata from this file; property `sort` values are seed
defaults, not recognition requirements. Python parity tests compare the same
manifest with the operator CLI's DDL and catalog output.

Consumers can import `life-core/schema/saved-views.json` or vendor that exact
file alongside the core bundle. Keep the vendored JSON and runtime from the
same source revision and hash the JSON separately from the unchanged bridge
contract. The source package includes `schema/`; browser/JavaScriptCore bundles
inline the JSON and need no filesystem loader. There is no separate core
`dist` build. Consumers compiling an unbundled distribution must also ship the
JSON at the relative path expected by the emitted import.

Treat the manifest as immutable. Only an explicitly app-owned local/demo
initializer may use it to create absent storage; check for partial/foreign
schema and catalog collisions before any creation, and never adopt or repair
them automatically. Ordinary synced replicas still receive existing logged
DDL only. Core exports no provisioning operation, and the manifest contains
no actual view definitions or default selection.

Run `bun test` and `bun run check` here, or `just test` / `just check` at the
repository root. The shared `tests/fixtures/sync-protocol/revisions.json` cases
run in both Python and TypeScript; core tests also call the actual Worker over
its D1-compatible SQLite test adapter. No live dataset is needed.

The JSON boundary lives in `contract/core.json`. Run
`bun ../scripts/generate-core-contract.ts` to regenerate TypeScript models,
operation pairs, and Swift `Core` models. Check mode is read-only and part of
`just check`. The generator intentionally supports only the schema vocabulary
in use; unsupported constructs fail. Swift codecs preserve required nulls and
optional missing/null/value fields and reject integers outside JS precision.
`CoreRequests` couples each Swift request to its response type; TS `CoreHandlers`
requires every current operation. `createCoreHandlers` invokes existing core
behavior, including `readRows` and `readOptions`, with platform dependencies
injected. This is an in-process API, not a server RPC negotiation protocol.

Consumers vendor the schema, generator and generated artifacts together. The
contract SHA-256 identifies that local artifact pair; their bridge must compare
it with the bundled runtime before dispatch. Consumers retain queues, file/Web
locks, host-only database lifecycle, and notification checkpoints. Generation
adds no platform timers, storage, credentials or speculative scoped sync.
