"""life-data: schema-agnostic personal data store — local-first SQLite, agent-friendly CLI."""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
DDL_KEYWORDS = {"CREATE", "ALTER", "DROP"}

PLUMBING = f"""
CREATE TABLE IF NOT EXISTS _schema_log (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT ({NOW}),
    ddl TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="life", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="create the data dir and database")
    sub.add_parser("path", help="print the database path")
    p_sql = sub.add_parser("sql", help="execute one SQL statement, results as JSON")
    p_sql.add_argument("statement")
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
    elif args.command == "table":
        create_table(path, args.name, args.columns)
        print(f"created table {args.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
