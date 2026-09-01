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

## Roadmap (build order)

1. `life sync` - replication via a Cloudflare D1 hub: row-cursor push/pull,
   last-write-wins on `updated_at`, tombstones via `deleted_at`, schema via
   `_schema_log` replay. State-based per row, never op-log.
2. `life import notion` - generic data-source importer: Notion page IDs
   become row `id`s, relations become junction tables.
3. `life backup` - SQL-text export to S3-compatible object storage.
