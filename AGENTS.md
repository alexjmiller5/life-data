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
  pushed rows per row and never fails a batch.
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
- `catalog_*` and `provenance` sync before every other table.
- `just test` runs pytest AND `bun test` in `worker/`.

## Sync internals

State-based, never op-log. `sync(path, hub)`: replay missing `_schema_log`
DDL both ways (idempotent-by-skip on "already exists" / "duplicate column"),
snapshot push candidates BEFORE applying the pull (else pulled rows echo
straight back), pull then push, then advance the per-direction cursors in
`_sync_state`. **The pull cursor is `hub.cursor(tables)` read BEFORE the pull
loop, not after it**: the hub writes rows itself (derivations on push and on
the sweep cron), and a row it writes between a table's pull query and a cursor
read taken after the loop would carry `updated_at <= cursor` yet never have
been pulled - silently skipped by every later sync. Reading first means any
hub write after the read has `updated_at >` the stored cursor and lands next
sync. The price is that a sync echoes back the rows it pushed the sync before,
which is harmless: the LWW upsert no-ops identical rows, and if the hub has a
newer version (a derivation) that is exactly what should be pulled. A single
client-stamped cursor still cannot recover a row pushed late with a stamp
older than the cursor (an offline replica): one client-stamped cursor per
direction assumes ~NTP-synced clocks, which holds for one person's devices.
The upsert carries rows as ONE json parameter through
`json_each` (D1 caps bind params at ~100/query) and is guarded by
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
siblings still land. A write is ONE `db.batch`: the value UPDATE plus a
provenance upsert per column, so a replica pulls row and proof together.
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
