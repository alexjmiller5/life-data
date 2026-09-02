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

Or, with home-manager, the flake ships a module — one toggle installs the
CLI (plus DuckDB for `--raw` queries), declares `config.json`, and runs the
continuous-sync daemon:

```nix
# flake input: life-data.url = "github:alexjmiller5/life-data";
imports = [ life-data.homeModules.default ];
lifeData = {
  enable = true;
  # each context authenticates independently:
  cli.tokenCommand = "op read 'op://vault/item/credential'";   # your shell's env
  watch.tokenCommand = "SESSION=$(cat /path) fetch hub-token"; # self-sufficient —
  # the daemon has no shell env; add its tools via watch.packages = [ ... ];
  # hubUrl = "https://your-hub.example.com";                   # self-hosters
};
```

## Use

```bash
life init                                  # create the data dir + database
life path                                  # print the database path
life table create people name:text birthday:text
life sql "INSERT INTO people (name) VALUES ('Ada')"
life sql "SELECT * FROM people"            # results as JSON
life sql "ALTER TABLE people ADD COLUMN likes TEXT"
life export > backup.sql                   # portable dump, no cloud involved
```

Every statement is plain SQLite SQL. Everything above works offline, forever,
with no account and no server.

## Sync (optional)

```bash
life sync     # one round trip with the hub
life watch    # continuous: pushes local writes within ~1s, polls for remote
```

Sync is state-based and last-write-wins per row on `updated_at`; deletes are
soft (`UPDATE ... SET deleted_at = updated_at`) so tombstones propagate — a
hard `DELETE` will not. Schema changes replay from `_schema_log`, so a brand
new device pulls the tables *and* the rows with one `life sync`.

Configure it in `config.json` in the data dir — every field is optional:

```json
{
  "hub_url": "https://your-hub.example.com",
  "token": "…",
  "token_cmd": "op read op://vault/item/credential",
  "headers": { "CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…" }
}
```

`hub_url` defaults to the hosted service. Credentials are a plain bearer
token: give it literally (`token`), via a command (`token_cmd`), or via the
`LIFE_HUB_TOKEN` environment variable, which wins over both. `headers` adds
arbitrary headers for hubs behind an authenticating proxy (e.g. Cloudflare
Access). The client has no provider-specific code.

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
- **`_schema_log`** records every DDL statement in order; replicas replay it.
- **`_sync_state`** holds the sync cursors.
- The client is pure Python standard library — no runtime dependencies.

## Importing data

There is no importer command by design: an agent (or you) maps any source
into the generic primitives — `life table create`, then transform records to
JSON and pipe them into `life insert <table>`. Use source record ids as row
`id`s so re-imports stay idempotent and cross-source relations survive.
