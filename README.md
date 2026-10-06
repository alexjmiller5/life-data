# life-data

A schema-agnostic personal data store: local-first SQLite with an
agent-friendly CLI, and an optional sync service. Think "headless Notion" -
you define your own tables at runtime, your data lives in a SQLite file on
your own machine, AI agents query and edit it with plain SQL, and every
device stays a complete replica whether or not the network is up.

The software is generic: it ships zero personal schema. Your tables, columns,
and rows are *state*, created entirely through the installed CLI - never by
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

On a new Mac, sign in through the browser and then enable sync:

```bash
life login --name "My laptop"
life background enable
```

Life opens the hub's Cloudflare Access email approval page. After approval,
it saves an independently revocable device token in macOS Keychain. No other
Life device, password-manager vault, service account, or provider token is
needed. Recovering after losing every Mac means installing Life again and
repeating these steps using the owner's email account. Login and sync opt-in
are separate choices.

The browser receives a public fingerprint, never the bearer token. An
unapproved fingerprint link does not expire on the server; the CLI waits up to
five minutes. Only approve a link from a login you are currently performing.
A fingerprint alone grants no access. Device management at `<hub>/login/devices`
revokes Life API credentials. It does not sign an owner out of Cloudflare Access:
for a lost device with a usable browser session, the service operator must also
revoke that identity's Access sessions and secure the email account. The hosted
service currently admits one owner and one dataset; it is not multi-user signup.

Keychain may require foreground macOS approval. Background reads never prompt:
if access requires interaction, the runner reports a sanitized OS error and
retries. Unlocking the screen and allowing the executable to read the Keychain
item are separate requirements. Disabling sync retains the credential.

`life logout` revokes the saved device token at its hub before removing the
Keychain item. Failed revocation retains the local token so logout can be
retried. For an existing externally provisioned device token, use
`life login --token-stdin`; admin tokens are rejected. Pipe credentials from
a trusted provider, never put them in arguments or shell history.

`--hub-url https://your-hub.example.com` selects a self-hosted instance.
Once a data directory has synced over HTTP, it is bound to that endpoint.
Use a fresh `LIFE_DATA_DIR` for a different hub; existing cursors and data
are never silently reused against another service. A replica without a recorded
endpoint performs one full sync to establish trustworthy cursors. This first
round can take longer for a large existing database. Pulls request pages of 200;
a failed page leaves the sync cursors unchanged for retry.

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

When content must disappear rather than be marked deleted (a soft-deleted
row and the `history` table both keep the old text), use `life purge`:

```bash
life purge notes 3f2a...                 # the row, its history and provenance edges
life sql "UPDATE notes SET body = '[redacted]' WHERE id = '3f2a...'"
life purge notes 3f2a... --col body      # only the old values of one column
```

A purge writes a marker to the `purges` table naming the table, row and
column, never the content. The marker syncs like a row: the hub and every
replica delete what it covers, and the hub silently drops copies stamped at
or before the marker that an out-of-date device pushes later. A copy written
after the marker (a re-import from the source) is new data and is kept;
purge again to remove it. Hub backups keep old copies until they expire.

Only one sync round runs per database, including manual and background calls.
The push checkpoint uses the local clock captured with a consistent snapshot;
it never advances from a remote row's future revision. The hub stamps arrivals
inside the committing transaction. Inclusive boundaries replay equal timestamps
without duplicating IDs or original history events.

Upgrading an older checkpoint triggers one complete reconciliation in both
directions. Successful completion records the upgrade so normal rounds remain
incremental; an interrupted or rejected recovery retries. This can take longer
than an ordinary sync on a large replica. It does not delete history or rebuild
rows from guesses. A detected local clock rollback also forces a full push.

`updated_at` remains the conflict revision and the local change-discovery field.
When importing historical records, keep the historical date in `created_at` or
a domain field and let `updated_at` use the current write time. Arbitrarily
backdated revisions can fall behind the checkpoint; equal revisions of the
same row do not overwrite one another.

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
Browser login selects the saved device session ahead of installation credential
commands. Logout suppresses implicit fallback until an explicit authentication
choice. An explicitly set `LIFE_HUB_TOKEN` remains an operator override.
Background credential commands are separate from interactive `token`/`token_cmd`.
User choices made through the CLI live in `background.json`; execution
status lives in `background-status.json`. Neither contains saved tokens.

## Self-hosting the hub

The hub is a Cloudflare Worker in `worker/`, storing the canonical replica in
one D1 and writing backups to R2. Token state lives in a separate D1 binding
named `AUTH_DB`; the user-controlled data D1 is never used as the auth store.
The bindings are declared in `worker/wrangler.jsonc`.

```bash
cd worker && bunx wrangler@4 deploy
bunx wrangler@4 secret put HUB_TOKEN     # operator/admin secret, never a consumer device credential
../scripts/cf-r2-lifecycle.py            # apply tiered backup retention
```

Before the first deploy, create the auth D1, add its id as the `AUTH_DB`
binding, and set the non-secret `LOGIN_ACCESS_AUD` variable to the audience
returned by `scripts/cf-login.py`. If the existing hub has `_tokens`, run
`scripts/migrate-auth-registry.py` once before switching clients to the new
worker. The Access application protects `<domain>/login` and its children
with email OTP; `/v1` remains bearer-token authenticated.

Browser clients (a web app on its own origin) need that origin listed in the
non-secret `CORS_ORIGINS` variable, comma-separated exact origins. Only listed
origins can read API responses; the `/login` pages never answer CORS.

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
`gunzip -c life-….sql.gz | sqlite3 restored.db`. D1 Time Travel separately covers each database under its configured plan.
These R2 SQL backups contain the data database, not the separate auth registry;
recovery of auth state uses that database's own recovery or device reenrollment.

## Streams (append-only data)

Tables hold rows you edit; **streams** hold append-only, timestamped events -
location pings, sensor readings, anything written once and read analytically.
Streams are hub-backed by nature (the events are born remote):

```bash
echo '{"lat": 42.36, "lon": -71.06, "tst": 1756789200}' | life stream append location
life stream tail location        # the freshest record
life archive query "SELECT * FROM life.events WHERE stream = 'location' LIMIT 10"
```

Any client that can POST JSON can feed a stream - e.g. OwnTracks in HTTP mode
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
`~/.local/share/life-data`. The database is a single `life.db` file - copying
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
- The client is pure Python standard library - no runtime dependencies.

## Importing data

There is no importer command by design: an agent (or you) maps any source
into the generic primitives - `life table create`, then transform records to
JSON and pipe them into `life insert <table>`. Use source record ids as row
`id`s so re-imports stay idempotent and cross-source relations survive.

### Hub write contract

Use `POST /v1/rows/insert` for creation that must never overwrite an existing
ID. It accepts `{table, columns, rows}` and returns `{inserted, existing,
rejected}`. Existing IDs, including tombstones, keep every stored field and
timestamp; their ignored initializer values are not validated. New rows must
pass the normal catalog contract and supply a millisecond UTC `updated_at`.
IDs must be unique nonempty strings within the request. History attachments
are not supported. Both `LocalHub.rows_insert` and `HttpHub.rows_insert`
expose this operation, using the existing `tables:write` permission.

Only committed insertion receipts count as new rows. Retrying after a lost
response can return `existing`, so callers cannot infer who created that row.
Separate chunks can commit before a later request fails. An older hub without
this route fails closed; creation callers must never fall back to upsert.
Deploy the route before releasing clients that require it.

`/v1/rows/push` retains sparse `columns`/`rows` patches and per-row rejection.
Every row must supply valid `updated_at` in exact `YYYY-MM-DDTHH:MM:SS.sssZ`
form, even on uncataloged tables. Only strictly newer revisions change stored
values. Required properties judge the merged row; explicit null clears optional
fields. Inserts validate SQLite defaults as well as supplied values; numeric
strings retain SQLite INTEGER/REAL coercion. References and dynamic options are
checked at each mutation, including changes earlier in the batch. Enforced catalog invariants and history are transactional on both hubs;
advisory rules remain advisory.

Use `POST /v1/rows/patch` for conditional edits to one existing row. Send
`{table, id, values, expected_revision: {updated_at, hub_at}}`, using the
revision from a prior row read (`hub_at: null` for a table without that clock).
The response is `{id, revision: {updated_at, hub_at}}` from the committed
transaction. The server advances the edit clock, including under client clock
skew, and validates sparse values, references, invariants and history together.
Identity, creation/edit/arrival clocks and tombstones cannot be patched here.
Empty or malformed patches return 400; a stale revision, missing row or
tombstone returns 409 `revision_conflict`; invalid values return 422
`validation_failed`. A failed write changes neither the row nor its history
or durable change events. After a timeout or conflict, reread and recompute
the intended edit; never fall back to an unconditional push.

The session capability `conditional_patch: "revision-v1"` advertises this
operation. Broad `tables:write` and exact `tables:write:<table>` grants are
supported; narrow callers retain all table eligibility checks. A write-only
credential receives the revision receipt, not the row's other values.

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
those mutations' attached events from the fallback. Deploy the transaction-time
arrival fix before clients perform checkpoint recovery. Deduplication is guaranteed for upgraded replicas
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

### Saved view query semantics

Version 1 saved definitions remain supported. Version 2 adds bounded filter
groups, relative dates and catalog option sorting. Flat filters and outer
groups combine with AND; each `{match: "all" | "any", filters}` group uses
AND or OR internally. Groups cannot nest. Queries permit at most 16 groups,
64 filters per group, 128 filters total and 16 ordered sort clauses.

`{column, op: "lte", relative: "today"}` compares a date or datetime with
the current local day. Relative filters also support `eq`, `ne`, `lt`, `gt`
and `gte`, and cannot include `value`. The saved definition retains `timeZone`
and optional `dayStartMinutes` (integer 0 through 1439, omitted means midnight).
The host resolves that policy and supplies runtime `calendar: {today, start, end}`.
`today` labels the civil date on which the current policy interval began;
the bounds are consecutive configured local boundaries expressed as exact UTC
millisecond timestamps, with an exclusive end. For a boundary in a daylight-saving
gap use the next valid local instant; for a repeated boundary use its first
occurrence. Resolve each boundary in the named timezone, never by subtracting a
fixed UTC offset. Date-only comparisons use `today`; timed comparisons use the
interval without changing source values. Refresh at the policy boundary and on
resume. Never persist this runtime clock.
Absent or invalid calendar context rejects execution instead of broadening it.

Sort `mode: "options"` uses catalog option order. Multi-selects use the
first stored selection; later selections do not break ties. Unknown values
remain visible after known options, then empty values, in either direction.
Remaining clauses apply in order, with a stable ID tie-breaker. Omitted mode
keeps ordinary value sorting. Older clients report version 2 unavailable.

Version 2 definitions may also store `actions: [{id, label, values}]` and an
ordered `layout: [{kind: "column" | "action", id}]`. Actions contain literal
property patches. They cannot change identity, clocks, deletion state or
read-only fields. Layout references must identify selected columns or existing
actions. Invalid definitions make that saved view unavailable.

Call core `runRowAction({viewId, actionId, rowId, expectedUpdatedAt})` with the
full selected row's revision. The mutation session resolves the current saved
action and row inside its writer transaction, then uses the ordinary validated
write, history and pending-sync path. A successful action supplies the same
undo receipt as an edit. A stale action or failed commit preserves the row and
previous undo receipt. This is a local commit; normal sync rejection handling
still applies. Definitions contain no executable expressions or workflow rules.

### Durable change subscriptions

`POST /v1/subscriptions` accepts `{label, start: "now", sources}`. Each
source names a table and a list of scalar TEXT, INTEGER or REAL columns.
Numeric changes preserve JSON numbers, including checkbox values `0` and `1`.
Add `lifecycle: true` to a source to record live row insertion, deletion and
restoration even when all watched values are null. Such events may have an
empty `changes` array; restoration uses operation `restore`. Without this
option, only watched value changes emit events and restoration retains the
legacy `update` operation. Timestamp-only edits and physical cleanup of an
already deleted row emit no event.

The optional session capability `subscription_features: "scalar-lifecycle-v1"`
advertises these semantics alongside the `durable-pull-v1` delivery protocol.
Poll `GET /v1/subscriptions/<id>/events?wait=30`, then acknowledge its durable
delivery with `POST /v1/subscriptions/<id>/ack` and `{delivery_id}` only after
retaining recoverable work. Consumers require `subscriptions:consume:<id>`
plus read grants for every source. A delivery repeats until acknowledged;
polling does not move the cursor. Capacity failures roll back the source
mutation. Source definitions are immutable; retire a subscription to replace
them. Existing subscriptions retain their exact stored trigger semantics.

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
