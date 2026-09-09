# life-data — agent instructions

Schema-agnostic personal data store: local-first SQLite + the `life` CLI,
plus an optional sync hub (a Cloudflare Worker in `worker/`). The client is
Python 3.12+, standard library only — **no runtime dependencies, keep it that
way**. Built with uv; packaged as a Nix flake app.

## The user/dev boundary (load-bearing)

The repo ships FUNCTIONALITY, generic for any user. The owner's tables,
columns, and rows are STATE in the data dir, created through the installed
CLI.

- Operating on the owner's data ("add a property", "query people", "create a
  table", "import from X") = **user op**: use the installed `life` CLI. Never
  open this repo for it, and NEVER add user-table schema (migrations, table
  definitions, seed data) or source-specific importers to this codebase.
- New capabilities and bug fixes = **dev work**: happens here, TDD, generic.

## Layout

- `src/life_data/__init__.py` — the whole client (CLI, sync engine, hubs).
- `src/life_data/catalog.py` — the catalog engine: typed properties, rules,
  derivations, provenance, check/audit/infer/doc. Pure over a sqlite3
  connection.
- `worker/src/index.js` — the hub service; `worker/wrangler.jsonc` declares
  its D1 + R2 bindings and backup cron (that declaration IS the provisioning).
- `worker/src/validate.js` — the hub-side mirror of the row validator;
  `tests/fixtures/validation-cases.json` is the contract both run.
- `scripts/cf-r2-lifecycle.py` — idempotent source of truth for backup
  retention tiers.
- `tests/test_core.py` — pytest: CLI, sync engine, hubs. `tests/test_catalog.py`
  — pytest: the catalog engine, sharing `tests/fixtures/validation-cases.json`
  with `worker/src/validate.js`. `worker/test/` — bun test over a
  `bun:sqlite` D1 shim. TDD: failing test first, then mutation-test (break
  the code, confirm the test fails).

## Conventions

- Data dir: `$LIFE_DATA_DIR` > `$XDG_DATA_HOME/life-data` >
  `~/.local/share/life-data`; the database is `life.db`. Nothing else may
  hardcode a path.
- `life table create` injects sync columns (`id` hex PK, `created_at`,
  `updated_at` + trigger, `deleted_at`) and writes a `catalog_properties` row
  per column from its typed `col:type[!][(a|b|c)]` syntax, so every table is
  documented from birth. DDL through `life sql` is recorded verbatim in
  `_schema_log`; ordered replay is how schema syncs. Underscore-prefixed
  tables are plumbing — created by `init()`, never logged.
- Timestamps: ISO 8601 UTC with milliseconds via SQLite
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Sync ordering depends on
  lexicographic == chronological; keep every new timestamp in this format.
- **Always invoke uv through `just`, never bare `uv run`**: the justfile puts
  the venv outside iCloud (`UV_PROJECT_ENVIRONMENT`). Bare `uv run` uses
  `./.venv` under iCloud, where macOS intermittently stamps the editable
  install's `.pth` UF_HIDDEN and Python 3.13+ silently ignores it
  (`ModuleNotFoundError: life_data`). If it strikes anyway:
  `chflags nohidden .venv/lib/python*/site-packages/*.pth`.
- `just` verbs: `run`, `test`, `check`, `fmt`, `deploy`.
- **Writes are validated.** `execute_sql` and `insert_rows` run inside
  `catalog.write()`: one transaction, every changed row checked in every table
  that has catalog properties OR is named by an invariant, `ValidationError`
  after ROLLBACK. **Changed rows come from the per-table `temp._before_<t>`
  snapshot diff, never a timestamp comparison** - a clock collision at
  millisecond resolution cuts both ways (an untouched legacy row looks
  changed; an UPDATE inside the same millisecond moves no `updated_at`). Only SELECT/PRAGMA/EXPLAIN/VALUES bypass it - a CTE
  (`WITH …`) does not, since it can end in INSERT/UPDATE/DELETE; a read-only
  CTE just pays a no-op transaction. Sync's pull upsert bypasses it on purpose
  (pulled rows were validated where they were written). The hub validates
  pushed rows per row and never fails a batch, **each against the MERGED row**
  - the stored row with the pushed columns applied. A push carries only the
  columns it writes, so whole-row rules (`required`, and the derived/immutable
  protections' notion of "changed") judge the row as it will BE: every required
  column is demanded in full only on an INSERT, and setting one to null is
  still rejected. Per-value checks (type/options/pattern/ref) judge only the
  columns the payload carries - a stored value is not this write's claim.
  `validateRow`'s `touched` option is what draws that line, and the shared
  fixture covers both sides of it.
  The Worker resolves existing rows and references in bulk. LocalHub holds
  BEGIN IMMEDIATE while validating, sparsely upserting, checking actual values,
  running enforced invariants, and logging history, with a savepoint per row.
  The Worker captures validation reads and asserts them unchanged inside its
  D1 transaction. Ordinary triggers created and dropped in that batch check
  actual NEW values and enforce invariants with OLD/NEW CTE contexts. INSERT
  defaults are resolved once, validated, and stored explicitly. Physical column
  affinity normalizes approved values. References/options_sql run at each
  mutation to observe earlier accepted rows. Read assertions run before helper
  DDL using SELECT CASE and SQLite integer overflow on mismatch. A failed
  invariant rolls back the batch; ordered splitting isolates rejected rows and
  revalidates duplicate IDs against earlier accepted state. Unexpected SQL
  failures roll back the submitted batch and surface as errors.
  Each pushed updated_at must be a real calendar timestamp in exact UTC
  millisecond form, independently of the catalog. Missing, null, unlisted,
  malformed, non-UTC or non-millisecond stamps reject per row. Stale/equal
  revisions do not change values or generate new hub history.
  Table writes/derivations require Workers Paid (1,000 D1 queries/invocation).
  Pushes budget 750 SQL statements, background derivations another 200, and
  direct/scheduled derivations share 900 across all nested callers, including
  precommit reads. Exhaustion preserves committed progress and reports pending
  work in failed; subsequent calls/sweeps resume. SQL text is bounded at D1's 100KB limit. Ordinary 500-row writes use bulk
  upserts. Budget exhaustion is retryable per row; sync leaves its push cursor
  unchanged whenever any row rejects.
- **Checks are pure; producers may touch the world.** Invariant SQL is one
  SELECT with no `random()`, `localtime`, or `'now'` (use `(SELECT ts FROM
  now)`; `changed`/`before` are temp tables the engine provides). Audits run
  via `life audit`. **Derivations are `http:<name>` and run on the hub only**:
  a client never writes a derived column (any write that changes one is
  rejected locally and again at the hub), and the hub verifies
  `provenance.inputs_hash`/`value_hash` against the pushed row. **A
  derivation's `inputs` must be cataloged columns** - both sides hash values as
  SQLite renders them, and the hub needs the catalog `type` to know a `number`
  binds through REAL (4 → `"4.0"`, not `"4"`).
- Every temp table the rule engine makes (`now`, `changed`, `before`,
  `_before_<t>`) is schema-qualified `temp.` - unqualified names fall through
  to `main`, so an unqualified DROP would delete a user table of that name.
- **Every table/column name interpolated into SQL is quoted**: `qi()` in
  `__init__.py`, `qident()` in `worker/src/validate.js` (both validate against
  `^[A-Za-z_][A-Za-z0-9_]*$` and refuse anything else rather than escaping it).
  A column named `cast` or `order` is otherwise a syntax error that breaks sync
  for the whole table. User-authored SQL (rule `sql`, `options_sql`, `sql:`
  defaults, `--where`) is left alone — that is the user's own SQL. The JSON
  path inside the upsert (`json_extract(value, '$.<col>')`) takes the RAW name:
  it is a JSON key, not SQL.
- `catalog_*` and `provenance` sync before every other table.
- **`history` is the engine's edit log**: original random IDs identify cell
  events. Local SQL writes, direct hub pushes and derivations log actual updates
  transactionally. Inserts, noops, stale/replayed writes, catalog, provenance
  and updated_at/hub_at churn generate no new hub events.
  Sync attaches original local events through the optional `history` list on
  rows/push. The hub validates and deduplicates these facts by ID, never
  rewriting an existing event. A linear degree/connectivity trail check
  determines whether they explain actual OLD->NEW, without ordering timestamp
  ties. Ordered revisions consume explanatory segments only after commit.
  Unused original events remain eligible through ordered batch isolation.
  A differing concurrent OLD preserves LWW and original events, plus
  one `hub:reconcile` cell transition. Stale rows may import unseen originals.
  Failed validation/invariants roll back both row and attached history.
  Ordinary history-table sync remains as an ID-idempotent fallback for old
  servers that ignore attachments. History sorts last, and events belonging
  to rejected mutations are withheld. Old clients do not attach history, so a
  new hub may log their transition before original random-ID events arrive;
  legacy compatibility is explicitly best effort. Upgraded replicas supplying
  originals receive the dedup guarantee; old or uninventoryed replicas can
  duplicate aggregate/original history until upgraded. Never infer away or
  delete original events, add client registries/gates, or require new endpoints.
- **A soft-deleted row is never validated** (its cells are history, not a
  claim), but its cell changes are still logged.
- **`rename_table` is the only table rename.** `execute_sql` refuses
  `ALTER TABLE … RENAME TO` (the guard is `RENAME_TABLE`; RENAME COLUMN stays
  allowed). The verb runs one `catalog.write(ddl=True)`: the ALTER, a
  `DROP TRIGGER IF EXISTS` of the old-named trigger and a CREATE of the
  new-named one (all logged, so they replay), then `catalog.rename_refs`:
  id-keyed rows whose id embeds the table name (`catalog_properties`
  `<tbl>.<col>`, `catalog_tables`, derived `provenance` `<tbl>:<ref>:<field>`)
  are REKEYED - copy under the new id, soft-delete the old - because an
  in-place id change would leave the hub's copy alive and pull it straight
  back; `ref_table`, rule `tbl`, edge `to_kind` and `history.tbl` are plain
  updates; rule `sql` and `options_sql` are rewritten by word boundary, and
  the DDL recompile in `write` rejects the rename if any rule still fails.
  Replay skips a RENAME TO whose source table is already gone
  (`_already_applied(exc, ddl)`; the hub mirrors it).
- **`provenance` is ONE table for every value's origin.** Hub derivations
  write rows with `rel='derived_from'`, `asserted_by='hub'`, `from_kind =
  'http:<name>'`, `from_ref = _source_ref ?? inputs_hash`, id
  `<to_kind>:<to_ref>:<field>`, plus `inputs_hash`/`value_hash`/`produced_at`.
  Clients write observation edges into the same table (a text, an email, a
  photo, an import backing a row or one column: `rel` evidence_of /
  mentions / imported_from, `field` = the column or NULL for the whole row,
  `detail` = pair-only JSON, id `<from_kind>:<from_ref>:<to_ref>`). It is
  engine-created (`CATALOG_TABLES`, last so its cataloging can log) but NOT
  in `ENGINE_TABLES`: it is cataloged from birth (`PROVENANCE_PROPERTIES`
  adds the descriptions and the two `options_sql` - every `derived_by` is
  automatically an allowed `from_kind`, every user table an allowed
  `to_kind`) and validated like a user table on both sides. Schema replay
  also skips `no such column` (a RENAME COLUMN a fresh replica's
  current-shape engine table never had).
- **`with connect(...)` CLOSES the connection** (`_Connection.__exit__`).
  The stdlib context manager only commits, and a sqlite3 connection sits in a
  reference cycle, so an un-closed one holds `life.db`/`-wal`/`-shm` until
  the cyclic GC runs; a sync opens hundreds, and launchd caps a daemon at
  256 files. Never hold a connection past its `with` block.
- **The watch daemon never exits on a failure it can wait out.** The wrapper
  retries the credential command in-process with backoff (60s doubling to
  1h) and `watch()` logs and continues on ANY sync exception, because a
  launchd restart (`ThrottleInterval = 30`) re-runs the credential command,
  and a secret manager's request budget is finite - two machines crash-
  looping every 30s exhausted a 1000/day budget by themselves.
- `just test` runs pytest AND `bun test` in `worker/`.
  The deploy workflow gates deployment on both suites.

## Sync internals

State-based, never op-log. `sync(path, hub)`: `ensure_hub_at`, replay missing
`_schema_log` DDL both ways (idempotent-by-skip on "already exists" /
"duplicate column"), snapshot push candidates BEFORE applying the pull (else
pulled rows echo straight back), pull then push, then advance the
per-direction cursors in `_sync_state`; any rejection keeps last_push unchanged.

**The two cursors measure different clocks.** `last_push` is local
`updated_at`: which of our rows are new. `last_pull` is **`hub_at`, the
arrival time the HUB stamps on its own clock** - a nullable TEXT column on
every synced table, added by `create_table` and backfilled into existing
tables by `ensure_hub_at`. That migration is logged DDL, so it replays to the
hub and every replica, and it carries a **literal `DEFAULT '<stamp>'`** so all
of them backfill existing rows to the SAME value - a plain `ADD COLUMN` leaves
NULLs, the hub's `max(hub_at)` cursor stays empty, and every sync re-pulls the
whole estate forever. A table that just gained the column also resets
`last_pull` to `''` for one full pull. Clients
never write it: `upsertSql`/`_upsert_sql` bind the hub's own `strftime` in its
place on insert and in `DO UPDATE SET`, and hub-side derivations re-stamp it.
**Whether to stamp is read off the HUB's own schema (`PRAGMA table_info`),
never off the pushed column list** - an un-upgraded client omits the column and
its rows would land unstamped, invisible to every replica whose cursor has
moved on; on a table that has no `hub_at` the hub degrades to the old
`updated_at` behaviour for cursor and pull rather than erroring. The pull
boundary is INCLUSIVE (`hub_at >= since`): a push landing in the same
millisecond as a cursor read must not be lost, and re-reading the boundary row
costs nothing. A NULL `hub_at` is older than everything, so `since = ''` pulls
the whole table. One hub clock means arrival order is total: a replica that
pushes an edit stamped older than another replica's cursor still gets a fresh
`hub_at` and reaches everyone. `updated_at` decides conflicts and nothing else.

**The pull cursor is `hub.cursor(tables)` (`max(hub_at)`) read BEFORE the pull
loop, not after it**: the hub writes rows itself (derivations on push and on
the sweep cron), and a row it writes between a table's pull query and a cursor
read taken after the loop would carry `hub_at <= cursor` yet never have been
pulled - silently skipped by every later sync. Reading first means any hub
write after the read lands next sync. The price is that the sync after a push
re-reads the rows it pushed (they were stamped after that cursor read), so
**`pulled` counts rows the LWW upsert APPLIED, not rows received** - a
re-read of our own rows changes nothing and reports 0. Advancing `last_pull`
past the cursor to skip that re-read is NOT safe: another replica's push can
land between our pull and our push.

The upsert carries rows as ONE json parameter through `json_each` (D1 caps
bind params at ~100/query) and is guarded by
`WHERE excluded.updated_at > t.updated_at` — that clause IS the LWW rule.

Hubs implement one interface (`ensure_ready`, `schema_pull/push`,
`rows_pull/push`, `cursor`): `LocalHub` (SQLite, used by tests) and
`HttpHub` (the service). Anything provider-specific lives behind it.

**`HttpHub` must send a real `User-Agent`** — Cloudflare's edge bot
protection 403s the default `Python-urllib/x.y` agent (error 1010) before
the request reaches the Worker.

`life watch` pushes within ~1s of a local write (fingerprinting the db AND
its `-wal`, since WAL mode leaves the main file untouched until checkpoint)
and polls for remote changes. Swapping that poll for a WebSocket is tracked
as a task and is a client-side change only.

## Hub service

`authenticate(request, env)` in `worker/src/index.js` is **the auth seam**:
it returns a tenant handle or null, and nothing downstream knows how the
caller was authenticated. Today it is a constant-time bearer-token compare
against the `HUB_TOKEN` Worker secret (single tenant). Real accounts (Better
Auth, per-user tokens) replace that function and nothing else; the natural
multi-tenant model is one D1 database per tenant, not a tenant column.

Backups: the cron dumps D1 to gzipped SQL and writes it into every retention
prefix today qualifies for. **Exclude D1's internal tables** (`_cf_%`) from
any `sqlite_master` walk — reading them raises `SQLITE_AUTH`.

Two cron triggers, dispatched in `scheduled()` on `event.cron`: `10 9 * * *`
is the backup, `*/15 * * * *` is the derivation sweep (`SWEEP_CRON` in
`index.js` must match `wrangler.jsonc`).

Derivations (`worker/src/derive.js`). `derived_by = "http:<name>"` resolves
ONLY through the `DERIVATIONS` Worker secret — a JSON object
`{name: {url, headers}}`. **No external source may be named in `worker/src`.**
The hub POSTs `{tbl, id, inputs:{col: value}}` and writes back the response
keys that are derived columns of that derivation (plus `_source_ref`);
anything else is ignored. Output runs through `validateRow` first — a value
failing its type/options/pattern is dropped and reported in `failed`, its
siblings still land. A write is ONE guarded `db.batch`: provenance, value UPDATE, enforced
invariants and actual cell history commit together. Reads captured before the
external request prevent a concurrent edit from receiving stale output.
Runs three ways: after `/v1/rows/push` via `ctx.waitUntil` (never delays the
response; a failure is retried by the sweep), on the 15-minute sweep
(underived or `inputs_hash`-stale, 50 per property), and synchronously via
`POST /v1/derive {table, ids, col?}` (>50 ids → 400). Routes take
`(body, db, env, ctx)` and may return a `Response` of their own. `life derive
<tbl>.<col> [--where <sql>]` is a client-side wrapper around that route: it
selects ids locally, calls `/v1/derive` in chunks of 50, and reports totals —
it never computes a derived value itself. Requires a hub token with
`tables:write` (or `full`/admin).

## Streams

Append-only events, hub-backed by design (tables are local-first; streams are
not — the events are born remote). `POST /v1/streams/<name>/append` stores the
request body VERBATIM as a time-prefixed landing object (raw is sacred, never
deleted — everything downstream is rebuildable from landing) plus a
`state/<stream>/latest.json` pointer for O(1) tail, then tees
`{stream, ingested_at, record}` into the Pipelines stream binding (`EVENTS`).
The tee must NEVER fail the append — landing is the source of truth.

Managed platform (all open beta, Workers Paid): Pipelines stream
`life_events` (explicit schema: stream string, ingested_at string, record
json) → pipeline `life_pipeline` (SQL passthrough) → Iceberg sink →
table `life.events` in the R2 Data Catalog on `life-data-archive`, managed
compaction enabled. `POST /v1/archive/query` proxies SQL to R2 SQL
(`api.sql.cloudflarestorage.com/api/v1/accounts/<acct>/r2-sql/query/<bucket>`)
with the Worker's `R2_SQL_TOKEN` secret — clients never hold a provider
token. Table columns: `stream`, `ingested_at`, `record` (JSON string),
`__ingest_ts`. `WHERE`/`count(*)` work; `record` needs client-side JSON
parsing or the `--raw` DuckDB path for field-level analytics.

Beta gotchas, all hit at build time (2026-09-02):
- **Creation order is load-bearing**: stream WITH explicit schema first,
  THEN sink, THEN pipeline. The sink creates the Iceberg table at sink
  creation with whatever shape it can see — created against a schema-less
  stream you get a useless `value` JSON-string column, and "writing to
  existing Catalog tables is not yet supported" blocks fixing it without
  dropping the table (Iceberg REST: get `prefix` from
  `catalog.cloudflarestorage.com/<acct>/<bucket>/v1/config`, then DELETE
  `/v1/<prefix>/namespaces/life/tables/events?purgeRequested=true`).
- Schema-less streams declare ONE required `value` field: events sent as
  `{stream, ...}` fail validation SILENTLY (binding send still succeeds).
- The wrangler `pipelines` binding wants the stream **ID**, not name; the
  ID changes when the stream is recreated — update wrangler.jsonc + deploy.
- Sinks with auto-created R2 credentials derive them from the token used at
  creation: deleting that API token strands the sink ("authentication
  failed", pipeline → failed state). Recreate sink + pipeline.
- The stream BUFFERS across sink failures/recreation — buffered events
  redeliver once a working sink exists. Landing remains the true raw record.
- **Delivery into `life.events` is AT-LEAST-ONCE and eventually consistent**:
  a send can land in the table minutes later and can be duplicated by
  redelivery (a 23-record replay once materialized as 46 rows). Never
  "verify" a tee by querying the table right away, and never re-send/replay
  because the count looks short — check the landing manifest instead (landing
  is exactly-once), wait out the sink roll, and treat residual projection
  duplicates as a query-time concern (dedupe on a record-level key).
- `EVENTS.send` can stall past 30s while still succeeding — the client's
  default timeout is 120s for this reason. A client-side timeout on
  append/batch does NOT mean the write failed: check the manifest before any
  retry (retrying a landed batch duplicates both landing and events).
- The old AI Agent CF token predates these products: use the platform token
  (below) for any pipelines/catalog/r2-sql wrangler ops.

Credentials, two layers:
- **Hub tokens** (the platform's own auth):
  - `AI Agent Life Data Hub Token` (AI Agent vault,
    `3qq7d6cltvwh3yzken2b46einm`): the ADMIN token (= the Worker's
    `HUB_TOKEN` secret) AND the agent estate's daily credential - Alex's
    Macs/agents are the sole CLI users, so per his 2026-09-02 decision they
    use admin directly (a separate scoped machine token added no real
    isolation: the SA on those machines can read this item regardless).
  - Scoped client tokens (hub `_tokens` D1 table, SHA-256 at rest; managed
    with `life token create/revoke/list` under the admin token): `phone` -
    streams:append, in OwnTracks + Alex's Personal vault ("Life Data
    OwnTracks Token"); `notion-automations` - tables:read, in that project's
    ENV item → Modal secret. Scopes: `full` (everything but token mgmt),
    `tables:read` (schema/rows/cursor pulls + stream/archive GETs),
    `tables:write` (`/v1/rows/push` + `/v1/derive`, nothing else),
    `streams:append`. Lost/retired client = revoke one name.
- **Cloudflare API tokens** (the service's own infrastructure, `Life Data`
  vault): `Life Data Platform Token` (`2vjluucdosnw5oxgc4iit4tfp4`;
  Pipelines/Catalog/R2/Workers/D1 write - platform ops + compaction service
  credential; do NOT rotate casually, the Pipelines sink derives its R2
  credentials from it) and `Life Data SQL Read Token`
  (`qxri5llxvud5dq7l3727pfchxe`; read-only, = the Worker's `R2_SQL_TOKEN`
  secret). The claude-code SA cannot read project vaults - agents needing
  these use the op-temp-sa flow or desktop auth (see 1password skill).
