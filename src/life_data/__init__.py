"""life-data: schema-agnostic personal data store — local-first SQLite, agent-friendly CLI."""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
DDL_KEYWORDS = {"CREATE", "ALTER", "DROP"}

PLUMBING_STMTS = [
    f"""CREATE TABLE IF NOT EXISTS _schema_log (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT ({NOW}),
    ddl TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS _sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
)""",
]
PLUMBING = ";\n".join(PLUMBING_STMTS) + ";"


def resolve_data_dir() -> Path:
    if override := os.environ.get("LIFE_DATA_DIR"):
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(xdg) / "life-data"


def db_path() -> Path:
    return resolve_data_dir() / "life.db"


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(PLUMBING)
    return path


def execute_sql(path: Path, sql: str) -> list[dict]:
    with connect(path) as conn:
        cur = conn.execute(sql)
        rows = [dict(r) for r in cur.fetchall()]
        first_word = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
        if first_word in DDL_KEYWORDS:
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (sql,))
    return rows


def insert_rows(path: Path, table: str, rows: list[dict]) -> int:
    with connect(path) as conn:
        for row in rows:
            cols = list(row)
            values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]
            placeholders = ", ".join("?" for _ in cols)
            conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})", values)
    return len(rows)


def create_table(path: Path, name: str, columns: list[str]) -> None:
    user_cols = ",\n    ".join(f"{c.split(':')[0]} {c.split(':', 1)[1].upper()}" for c in columns)
    ddl = f"""CREATE TABLE {name} (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    {user_cols},
    created_at TEXT NOT NULL DEFAULT ({NOW}),
    updated_at TEXT NOT NULL DEFAULT ({NOW}),
    deleted_at TEXT
)"""
    trigger = f"""CREATE TRIGGER {name}_updated_at AFTER UPDATE ON {name} FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE {name} SET updated_at = ({NOW}) WHERE rowid = NEW.rowid;
END"""
    execute_sql(path, ddl)
    execute_sql(path, trigger)


class LocalTarget:
    """SQL target backed by a plain SQLite file (tests, local hubs)."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def query(self, sql: str, params: list | tuple = ()) -> list[dict]:
        with connect(self.path) as conn:
            cur = conn.execute(sql, tuple(params))
            return [dict(r) for r in cur.fetchall()]


class D1Target:
    """SQL target backed by a Cloudflare D1 database over the REST API."""

    def __init__(self, account_id: str, database_id: str, token: str):
        self.url = (
            "https://api.cloudflare.com/client/v4/accounts/"
            f"{account_id}/d1/database/{database_id}/query"
        )
        self.token = token

    def query(self, sql: str, params: list | tuple = ()) -> list[dict]:
        req = urllib.request.Request(
            self.url,
            data=json.dumps({"sql": sql, "params": list(params)}).encode(),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req) as r:
                resp = json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"D1 HTTP {e.code}: {e.read().decode()[:500]}") from e
        if not resp.get("success"):
            raise RuntimeError(f"D1 error: {resp.get('errors')}")
        return resp["result"][0].get("results", [])


def _get_state(path: Path, key: str) -> str:
    rows = execute_sql(path, f"SELECT value FROM _sync_state WHERE key = '{key}'")
    return rows[0]["value"] if rows else ""


def _set_state(local: LocalTarget, key: str, value: str) -> None:
    local.query(
        "INSERT INTO _sync_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )


def _apply_ddl(target, applied_at: str, ddl: str) -> None:
    try:
        target.query(ddl)
    except Exception as e:  # replay is idempotent-by-skip for already-applied DDL
        if "already exists" not in str(e).lower() and "duplicate column" not in str(e).lower():
            raise
    target.query("INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)", [applied_at, ddl])


def _user_tables(local: LocalTarget) -> list[str]:
    rows = local.query("SELECT name FROM sqlite_master WHERE type = 'table'")
    return [r["name"] for r in rows if not r["name"].startswith(("_", "sqlite_"))]


def _columns(local: LocalTarget, table: str) -> list[str]:
    return [r["name"] for r in local.query(f"PRAGMA table_info({table})")]


def _upsert_sql(table: str, cols: list[str]) -> str:
    # rows travel as ONE json parameter (D1 caps bind params at ~100/query);
    # `WHERE true` disambiguates SELECT-source upserts for SQLite's parser
    exts = ", ".join(f"json_extract(value, '$.{c}')" for c in cols)
    sets = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "id")
    return (
        f"INSERT INTO {table} ({', '.join(cols)}) "
        f"SELECT {exts} FROM json_each(?) WHERE true "
        f"ON CONFLICT(id) DO UPDATE SET {sets} "
        f"WHERE excluded.updated_at > {table}.updated_at"
    )


def _max_updated_at(target, tables: list[str]) -> str:
    top = ""
    for t in tables:
        rows = target.query(f"SELECT max(updated_at) AS m FROM {t}")
        top = max(top, rows[0]["m"] or "")
    return top


CHUNK = 200  # rows per upsert statement (one json param regardless of width)


def sync(path: Path, hub) -> dict:
    """State-based replica sync: schema replay, then pull, then push. LWW on updated_at."""
    local = LocalTarget(path)
    for stmt in PLUMBING_STMTS:
        hub.query(stmt)

    # schema: replay missing _schema_log entries on each side, ordered by time
    local_log = local.query("SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")
    hub_log = hub.query("SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")
    local_ddls = {r["ddl"] for r in local_log}
    hub_ddls = {r["ddl"] for r in hub_log}
    ddl_applied = 0
    for r in local_log:
        if r["ddl"] not in hub_ddls:
            _apply_ddl(hub, r["applied_at"], r["ddl"])
            ddl_applied += 1
    for r in hub_log:
        if r["ddl"] not in local_ddls:
            _apply_ddl(local, r["applied_at"], r["ddl"])
            ddl_applied += 1

    tables = _user_tables(local)
    # ponytail: single global cursor per direction; assumes ~NTP-synced clocks,
    # fine for one human's devices
    last_pull = _get_state(path, "last_pull")
    last_push = _get_state(path, "last_push")

    pulled = pushed = 0
    for t in tables:
        cols = _columns(local, t)
        # snapshot push candidates BEFORE applying the pull, so pulled rows
        # are never echoed back at the hub
        mine = local.query(f"SELECT {', '.join(cols)} FROM {t} WHERE updated_at > ?", [last_push])

        remote = hub.query(f"SELECT {', '.join(cols)} FROM {t} WHERE updated_at > ?", [last_pull])
        for i in range(0, len(remote), CHUNK):
            local.query(_upsert_sql(t, cols), [json.dumps(remote[i : i + CHUNK])])
        pulled += len(remote)
        for i in range(0, len(mine), CHUNK):
            hub.query(_upsert_sql(t, cols), [json.dumps(mine[i : i + CHUNK])])
        pushed += len(mine)

    _set_state(local, "last_pull", _max_updated_at(hub, tables))
    _set_state(local, "last_push", _max_updated_at(local, tables))
    return {"pushed": pushed, "pulled": pulled, "ddl_applied": ddl_applied}


def dump_sql(path: Path) -> str:
    with connect(path) as conn:
        return "\n".join(conn.iterdump())


def load_config(data_dir: Path | None = None) -> dict:
    cfg = (data_dir or resolve_data_dir()) / "config.json"
    if not cfg.exists():
        raise SystemExit(f"missing {cfg} — see README for the hub/backup config shape")
    return json.loads(cfg.read_text())


def _token(hub: dict) -> str:
    if env := os.environ.get("LIFE_HUB_TOKEN"):
        return env
    return subprocess.run(
        hub["token_cmd"], shell=True, capture_output=True, text=True, check=True
    ).stdout.strip()


def _hub_from_config(config: dict) -> D1Target:
    hub = config["hub"]
    return D1Target(hub["account_id"], hub["database_id"], _token(hub))


def backup(path: Path, config: dict) -> str:
    """Dump the local db as SQL text and PUT it to R2 via the Cloudflare API."""
    b = config["backup"]
    hub = config["hub"]
    token = _token(hub)
    key = b.get("prefix", "") + datetime.now(UTC).strftime("life-%Y%m%d-%H%M%S.sql")
    url = (
        "https://api.cloudflare.com/client/v4/accounts/"
        f"{hub['account_id']}/r2/buckets/{b['bucket']}/objects/{key}"
    )
    req = urllib.request.Request(
        url,
        data=dump_sql(path).encode(),
        headers={"Authorization": f"Bearer {token}"},
        method="PUT",
    )
    with urllib.request.urlopen(req) as r:
        resp = json.load(r)
    if not resp.get("success"):
        raise RuntimeError(f"R2 error: {resp.get('errors')}")
    return key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="life", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="create the data dir and database")
    sub.add_parser("path", help="print the database path")
    p_sql = sub.add_parser("sql", help="execute one SQL statement, results as JSON")
    p_sql.add_argument("statement")
    p_insert = sub.add_parser("insert", help="bulk-insert rows from a JSON array on stdin")
    p_insert.add_argument("table")
    sub.add_parser("sync", help="sync with the hub configured in config.json")
    sub.add_parser("backup", help="dump SQL to the R2 bucket configured in config.json")
    p_table = sub.add_parser("table", help="table operations")
    t_sub = p_table.add_subparsers(dest="table_command", required=True)
    p_create = t_sub.add_parser("create", help="create a table with sync columns")
    p_create.add_argument("name")
    p_create.add_argument("columns", nargs="+", metavar="name:type")
    args = parser.parse_args(argv)

    path = db_path()
    if args.command == "init":
        init(path)
        print(path)
    elif args.command == "path":
        print(path)
    elif args.command == "sql":
        rows = execute_sql(path, args.statement)
        print(json.dumps(rows, indent=2))
    elif args.command == "insert":
        n = insert_rows(path, args.table, json.load(sys.stdin))
        print(f"inserted {n} rows into {args.table}")
    elif args.command == "sync":
        stats = sync(path, _hub_from_config(load_config()))
        print(json.dumps(stats))
    elif args.command == "backup":
        key = backup(path, load_config())
        print(f"backed up to {key}")
    elif args.command == "table":
        create_table(path, args.name, args.columns)
        print(f"created table {args.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
