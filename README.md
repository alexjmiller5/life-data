# life-data

A schema-agnostic personal data store: local-first SQLite with an
agent-friendly CLI. Think "headless Notion" - you define your own tables at
runtime through the CLI, your data lives in one SQLite file on your machine,
and AI agents query and edit it with plain SQL. No server, no migrations to
write, no vendor.

The software is generic: it ships zero personal schema. Your tables, columns,
and rows are *state*, created and evolved entirely through the installed
CLI - never by editing this repo.

## Install

```bash
nix profile install github:alexjmiller5/life-data
# or in a flake / home-manager setup, add the package from this flake's outputs
```

## Usage

```bash
life init                                  # create the data dir + database
life path                                  # print the database path
life table create people name:text birthday:text
life sql "INSERT INTO people (name) VALUES ('Ada')"
life sql "SELECT * FROM people"            # results as JSON
life sql "ALTER TABLE people ADD COLUMN likes TEXT"
```

Every statement is plain SQLite SQL. `life sql` prints query results as JSON.

## Where data lives

`$LIFE_DATA_DIR` if set, else `$XDG_DATA_HOME/life-data`, else
`~/.local/share/life-data`. The database is a single `life.db` file - copying
it is a complete backup. Never place the data dir inside a file-sync folder
(iCloud Drive, Dropbox): file-level sync corrupts SQLite WAL databases.

## Design

- **Tables created via `life table create` get sync-ready columns
  automatically**: `id` (random 128-bit hex, primary key), `created_at`,
  `updated_at` (maintained by trigger), `deleted_at` (for soft deletes). ISO
  8601 UTC timestamps with millisecond precision.
- **`_schema_log`** records every DDL statement executed through the CLI, in
  order - replicas replay it to converge on the same schema.
- **`_sync_state`** holds sync cursors (used by the upcoming sync engine).
- Zero runtime dependencies: Python stdlib only.

## Sync and backup

`life sync` replicates through a hub (Cloudflare D1) so every machine holds a
full copy: pull, then push, last-write-wins per row on `updated_at`, soft
deletes via `deleted_at`, schema replayed from `_schema_log`. `life backup`
PUTs a full SQL dump to R2. Both read `config.json` in the data dir:

```json
{
  "hub": {
    "account_id": "<cloudflare account id>",
    "database_id": "<d1 database id>",
    "token_cmd": "op read op://<vault>/<item>/credential"
  },
  "backup": { "bucket": "<r2 bucket>", "prefix": "backups/" }
}
```

The Cloudflare API token needs D1 edit + R2 write scopes; `token_cmd` is any
command printing it (`LIFE_HUB_TOKEN` env overrides it). Deletes must be
soft (`UPDATE ... SET deleted_at = updated_at`) — hard DELETEs don't
propagate.

## Importing data

There is no importer command by design: an AI agent (or you) maps any source
into the generic primitives - `life table create`, then transform the source
records to JSON and pipe them into `life insert <table>`. Source record IDs
become row `id`s so re-imports and cross-source relations stay stable.

## Roadmap

- `life sync`: local-first replication between machines through a Cloudflare
  D1 hub (row-cursor, last-write-wins; schema changes replayed from
  `_schema_log`).
- `life backup`: SQL-text export to object storage.
