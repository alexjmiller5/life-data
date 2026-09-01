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
- `worker/src/index.js` — the hub service; `worker/wrangler.jsonc` declares
  its D1 + R2 bindings and backup cron (that declaration IS the provisioning).
- `scripts/cf-r2-lifecycle.py` — idempotent source of truth for backup
  retention tiers.
- `tests/test_core.py` — pytest. TDD: failing test first, then mutation-test
  (break the code, confirm the test fails).

## Conventions

- Data dir: `$LIFE_DATA_DIR` > `$XDG_DATA_HOME/life-data` >
  `~/.local/share/life-data`; the database is `life.db`. Nothing else may
  hardcode a path.
- `life table create` injects sync columns (`id` hex PK, `created_at`,
  `updated_at` + trigger, `deleted_at`). DDL through `life sql` is recorded
  verbatim in `_schema_log`; ordered replay is how schema syncs.
  Underscore-prefixed tables are plumbing — created by `init()`, never logged.
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

## Sync internals

State-based, never op-log. `sync(path, hub)`: replay missing `_schema_log`
DDL both ways (idempotent-by-skip on "already exists" / "duplicate column"),
snapshot push candidates BEFORE applying the pull (else pulled rows echo
straight back), pull then push, then advance the per-direction cursors in
`_sync_state`. The upsert carries rows as ONE json parameter through
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
