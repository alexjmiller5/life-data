# life-data — agent instructions

Schema-agnostic personal data store: local-first SQLite + agent-friendly CLI
(`life`). Python 3.12+, stdlib only (no runtime dependencies - keep it that
way). Built with uv; packaged as a Nix flake app.

## The user/dev boundary (load-bearing)

This product's core principle: the repo ships FUNCTIONALITY, generic for any
user. The owner's tables, columns, and rows are STATE in the data dir,
created through the installed CLI.

- Operating on the owner's data ("add a property", "query people", "create a
  table") = **user op**: use the installed `life` CLI. Never open this repo
  for it, and NEVER add user-table schema (migrations, table definitions,
  seed data) to this codebase.
- New capabilities and bug fixes = **dev work**: happens here, TDD, generic.

## Layout

- `src/life_data/__init__.py` - the whole product (CLI + core). Keep it one
  module until size genuinely forces a split.
- `tests/test_core.py` - pytest suite. TDD: failing test first, mutation-test
  afterward (break the code, confirm the test fails).

## Conventions

- Data dir resolution: `$LIFE_DATA_DIR` > `$XDG_DATA_HOME/life-data` >
  `~/.local/share/life-data`; database file is `life.db`. Nothing else may
  hardcode a path.
- `life table create` injects sync columns (`id` hex-random PK, `created_at`,
  `updated_at` + trigger, `deleted_at`). User DDL through `life sql` is
  recorded verbatim in `_schema_log` (ordered replay is the schema-sync
  mechanism). Underscore-prefixed tables are internal plumbing - created only
  by `init()`, never logged.
- Timestamps: ISO 8601 UTC with milliseconds via SQLite
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')` - keep every new timestamp
  consistent with this format (sync ordering depends on lexicographic = 
  chronological).
- `just` verbs: `run` (CLI passthrough), `test`, `check`, `fmt`.
- **Always invoke uv through `just`, never bare `uv run`**: the justfile
  relocates the venv outside iCloud (UV_PROJECT_ENVIRONMENT). Bare `uv run`
  uses `./.venv` under iCloud, where macOS intermittently stamps the editable
  install's .pth UF_HIDDEN and Python 3.13+ silently ignores it
  (ModuleNotFoundError: life_data). If that strikes anyway:
  `chflags nohidden .venv/lib/python*/site-packages/*.pth`.

## Imports are agent work, not product code

There is deliberately no `life import <source>` command. Migrating data in
(Notion, Garmin, anything) = a user op: the agent fetches from the source and
maps it through the generic primitives (`life table create`, `life insert`
with JSON on stdin, `life sql`). Source IDs become row `id`s (Notion page
UUIDs dash-stripped to 32 hex), source relations become junction tables,
multi-value fields become JSON-array text columns. Never add source-specific
importer code to this repo.

## Sync internals

`sync(path, hub)` is state-based, never op-log: replay missing `_schema_log`
DDL on both sides (idempotent-by-skip on "already exists"/"duplicate
column"), snapshot push candidates BEFORE applying the pull (else pulled
rows echo back), pull then push via a single-JSON-parameter `json_each`
upsert (D1 caps bind params at ~100/query) guarded by
`WHERE excluded.updated_at > t.updated_at` (the LWW rule), then advance the
global per-direction cursors in `_sync_state`. Hub targets implement
`.query(sql, params)` — `LocalTarget` (tests) and `D1Target` (Cloudflare
REST). Soft deletes only: `deleted_at` propagates, hard DELETEs don't.
`life backup` = `iterdump` → R2 object PUT via the Cloudflare API (no S3
signing).
