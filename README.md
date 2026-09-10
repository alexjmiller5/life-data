# life-data

A schema-agnostic personal data store: local-first SQLite with an
agent-friendly CLI, and an optional sync service. Think "headless Notion" —
you define your own tables at runtime, your data lives in a SQLite file on
your own machine, AI agents query and edit it with plain SQL, and every
device stays a complete replica whether or not the network is up.

The software is generic: it ships zero personal schema. Your tables, columns,
and rows are *state*, created entirely through the installed CLI — never by
editing this repo.

## Install

```bash
nix profile install github:alexjmiller5/life-data
```

Or use the exported Home Manager module on macOS. It installs the CLI,
DuckDB and a supervised background runner. Sync starts **off**:

```nix
imports = [ life-data.homeModules.default ];
lifeData.enable = true;
```

Optional defaults: `hubUrl`, `cli.tokenCommand`, and `watch.tokenCommand`.
The two credential commands are independent; neither is required. Add any
background command's dependencies through `watch.packages`.
`watch.enable = false` omits the runner entirely.

## Use

```bash
life init                                  # create the data dir + database
life path                                  # print the database path
life table create people name:text birthday:text
life sql "INSERT INTO people (name) VALUES ('Ada')"
life sql "SELECT * FROM people"            # results as JSON
life sql "ALTER TABLE people ADD COLUMN likes TEXT"
life table rename people humans            # the ONLY way to rename a table
life sql "SELECT * FROM history WHERE tbl = 'humans' ORDER BY created_at"
life export > backup.sql                   # portable dump, no cloud involved
```

Every statement is plain SQLite SQL. Everything above works offline, forever,
with no account and no server.

## Sync (optional)

```bash
life sync                    # one round trip
life watch                   # sync in this terminal until interrupted
life background enable       # enable the installed background runner
life background disable      # finish the current round, then stop syncing
life background status       # enabled, running, last success/error and counts
```

On macOS, supply a **Life-issued device token** once through stdin:

```bash
life background enable --token-stdin
```

Pipe the token from your credential provider. Life stores it in the macOS
Keychain, never in a file, process arguments, or logs. Keychain access may
require macOS approval. The token is scoped to this data directory and hub
URL. `--hub-url https://your-hub.example.com` selects a self-hosted instance.
Once a data directory has synced over HTTP, it is bound to that endpoint.
Use a fresh `LIFE_DATA_DIR` for a different hub; existing cursors and data
are never silently reused against another service. A replica without a recorded
endpoint performs one full sync to establish trustworthy cursors. This first
round can take longer for a large existing database.
The CLI requests rows in pages of 200 so large tables fit within the hub's
response limits. A failed page leaves the sync cursors unchanged for retry.
Keychain storage is also used by ordinary hub commands when no interactive
credential override is configured. Disabling sync retains the credential.
A locked or unavailable Keychain causes a retry with a visible error state.

Alternatively, pass `--token-command 'credential-tool read hub-token'`.
It runs in the daemon's environment; it must work without a terminal.
`LIFE_HUB_TOKEN` in that environment takes precedence. No password manager,
vault, or service account is required by Life. A credential command is read
once per enabled session/configuration; a rejected credential is reloaded
with backoff. Never put a token literal in a command or shell history.

The Home Manager module owns installation and login startup. The CLI owns
the mutable on/off setting, which survives process restarts and Nix rebuilds.
With only the standalone package installed, `background status` reports
`running: false`; install the module for automatic login startup, or run
`life background run` under your own supervisor. The runner stays idle
while disabled, making no hub or credential requests. Only one runner can
hold a data directory at a time. Failures retry after 60 seconds, doubling
to a maximum of one hour. Re-enabling resets that wait. `last_success`
advances only after a round with no rejected rows. The status output never
includes row payloads or credential-command output.

Sync is state-based and last-write-wins per row on `updated_at`; deletes are
soft (`UPDATE ... SET deleted_at = updated_at`) so tombstones propagate. A
hard `DELETE` does not. Schema changes replay from `_schema_log`, so a new
device pulls tables and rows with `life init` followed by `life sync`.

`config.json` in the data directory provides optional installation defaults:

```json
{
  "hub_url": "https://your-hub.example.com",
  "token_cmd": "credential-tool read interactive-token",
  "background_token_cmd": "credential-tool read device-token"
}
```

The interactive client also accepts `token` in config and extra proxy
`headers`; `LIFE_HUB_TOKEN` and `LIFE_HUB_URL` override file configuration.
Background credentials are separate from interactive `token`/`token_cmd`.
User choices made through the CLI live in `background.json`; execution
status lives in `background-status.json`. Neither contains saved tokens.

## Self-hosting the hub

The hub is a Cloudflare Worker in `worker/`, storing the canonical replica in
D1 and writing backups to R2 — all declared in `worker/wrangler.jsonc`.

```bash
cd worker && bunx wrangler@4 deploy
bunx wrangler@4 secret put HUB_TOKEN     # the bearer token clients present
../scripts/cf-r2-lifecycle.py            # apply tiered backup retention
```

Point clients at it with `hub_url`, and you own the whole loop.

### Backups

The hub's daily cron dumps the database to R2 as gzipped SQL, writing into
the prefix matching how long that copy should live:

| Prefix     | Written | Kept |
|------------|---------|------|
| `daily/`   | daily   | 35 days |
| `weekly/`  | Sundays | 190 days |
| `monthly/` | the 1st | 400 days |
| `yearly/`  | Jan 1   | forever |

Retention is enforced by R2 lifecycle rules; `scripts/cf-r2-lifecycle.py` is
their source of truth. Restore any of them with
`gunzip -c life-….sql.gz | sqlite3 restored.db`. D1's own Time Travel
separately covers point-in-time restore for the last 7 days.

## Streams (append-only data)

Tables hold rows you edit; **streams** hold append-only, timestamped events —
location pings, sensor readings, anything written once and read analytically.
Streams are hub-backed by nature (the events are born remote):

```bash
echo '{"lat": 42.36, "lon": -71.06, "tst": 1756789200}' | life stream append location
life stream tail location        # the freshest record
life archive query "SELECT * FROM life.events WHERE stream = 'location' LIMIT 10"
```

Any client that can POST JSON can feed a stream — e.g. OwnTracks in HTTP mode
pointed at `<hub>/v1/streams/location/append` with the token as its Basic-auth
password. The hub stores every event verbatim as a landing object (raw is
sacred, never deleted) and tees it into a managed pipeline that builds an
Apache Iceberg table (`life.events`) with automatic compaction. Queries run
server-side over that table; `--raw` instead runs local DuckDB against the
raw landing/parquet objects (needs `duckdb` on PATH).

On Cloudflare that machinery is Pipelines + R2 Data Catalog + R2 SQL (open
beta, Workers Paid); self-hosters get the landing/tail/manifest endpoints
regardless, and everything is rebuildable from landing.

## Where data lives

`$LIFE_DATA_DIR` if set, else `$XDG_DATA_HOME/life-data`, else
`~/.local/share/life-data`. The database is a single `life.db` file — copying
it is a complete backup. Never put the data dir inside a file-sync folder
(iCloud Drive, Dropbox): file-level sync corrupts SQLite WAL databases.

## Design

- **Tables created via `life table create` get sync-ready columns
  automatically**: `id` (random 128-bit hex), `created_at`, `updated_at`
  (trigger-maintained), `deleted_at`. ISO 8601 UTC, millisecond precision.
- **`history`** records every edit to every cataloged table, one row per
  changed cell (`tbl`, `row_id`, `col`, `old`, `new`, `origin` = hostname,
  `created_at` = when), in the same transaction as the edit. Updates only:
  an insert is `created_at` plus the row, and a cell's first change keeps its
  original value in `old`, so the full timeline is reconstructible. It syncs
  like any table.
- **`life table rename OLD NEW`** renames a table and every reference to it
  (catalog properties and refs, rule SQL, provenance, history) in one
  transaction, as logged DDL. A raw `ALTER TABLE … RENAME TO` through
  `life sql` is refused because it would leave those references dangling.
- **`_schema_log`** records every DDL statement in order; replicas replay it.
- **`_sync_state`** holds the sync cursors.
- The client is pure Python standard library — no runtime dependencies.

## Importing data

There is no importer command by design: an agent (or you) maps any source
into the generic primitives — `life table create`, then transform records to
JSON and pipe them into `life insert <table>`. Use source record ids as row
`id`s so re-imports stay idempotent and cross-source relations survive.

### Hub write contract

`/v1/rows/push` retains sparse `columns`/`rows` patches and per-row rejection.
Every row must supply valid `updated_at` in exact `YYYY-MM-DDTHH:MM:SS.sssZ`
form, even on uncataloged tables. Only strictly newer revisions change stored
values. Required properties judge the merged row; explicit null clears optional
fields. Inserts validate SQLite defaults as well as supplied values; numeric
strings retain SQLite INTEGER/REAL coercion. References and dynamic options are
checked at each mutation, including changes earlier in the batch. Enforced catalog invariants and history are transactional on both hubs;
advisory rules remain advisory.

An optional `history` array carries original replica events for submitted rows,
using the history-table shape and original IDs. Matching IDs are idempotent;
conflicting reuse rejects the row. Original events that explain a cell transition
replace an aggregate hub entry, including several ordered revisions of one ID. If a concurrent hub value differs, LWW still
applies and one `hub:reconcile` event records the actual hub transition while
preserving the local events. Single-transition whole trails use a linear check;
ordered revisions use bounded backtracking over disjoint event paths, including
cyclic/coalesced edits. Timestamp ties imply no ordering. Stale/replayed
rows generate no hub events, though unseen originals can still replicate.
Invariant rejection rolls back both mutation and attached events. A proven
history mismatch still reconciles. If matching needs more than 10,000 generated
search states, the whole request rolls back and returns zero upserts, empty
`hub_at`, and one `history-ambiguity` rejection with `retryable: true` for every
submitted row, in order. Split revisions into smaller requests and retry; an
identical oversized request may reject again. No automatic split is added to sync.

History-bearing D1 batches that need failure isolation use rollback-only probes
before committing the accepted sequence once. Matcher or query exhaustion during
isolation cannot leave earlier siblings, original events, or helper tables behind.
Valid bulk requests still use one transaction.

Sync keeps ordinary history-table replication as a fallback for servers that
ignore the optional array. Rejections keep the push cursor in place and withhold
those mutations' attached events from the fallback. Upgrade clients before the
Worker where possible. Deduplication is guaranteed for upgraded replicas
supplying original events; legacy compatibility is explicitly best effort.
An older or uninventoryed replica sends history separately, so a new Worker
cannot reliably recognize an original random-ID event before logging the direct
transition. Historical rows are never rewritten to guess away legacy duplicates.

The hosted Worker and self-hosted table-write/derivation service require
**Workers Paid** (D1's 1,000-query invocation limit); the Free 50-query ceiling
is not supported by these write budgets. Each batch statement counts as a query.
Push validation/isolation allows 750 statements, background derivation 200, and
direct/scheduled derivations share a 900-statement budget across all rows and
nested callers. Headroom covers route/auth work. A partial derivation returns
committed progress plus explicit `failed` entries for pending work; retry those
IDs or let the next sweep resume. SQL stays within 100KB and bulk row data uses
JSON parameters to remain below 100 binds per statement.

Normal 500-row pushes and 200-row provenance chunks with schema-derived options
and references use bulk reads/upserts and transaction-scoped triggers.
D1 statement/text budgets fail closed with per-row rejections; retry those rows
in smaller batches. No partial history remains after a failed transaction.

### Files

`PUT /v1/files/<key>` stores a binary body with its `Content-Type`.
`GET` and `HEAD` on the same URL return the stored bytes or metadata (404
for an absent key). URL-encode each key segment; empty segments, dot
segments, encoded separators, control characters and percent signs in
stored keys are rejected. Uploading an existing key replaces its contents.
There is no file deletion or listing endpoint.

Mint client tokens with literal, slash-terminated namespace scopes, for
example `files:read:photos/client/,files:write:photos/client/`. Read and
write grants are independent. A table scope grants no file access. The
legacy `/v1/archive/<key>` read route uses the same file read grants;
`full` and `admin` retain whole-archive access. Clients need only the hub
URL and their scoped bearer token, never storage-provider credentials.
