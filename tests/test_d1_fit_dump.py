"""scripts/d1-fit-dump.py: a hub backup restores into D1 statement by statement."""

import sqlite3
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "d1-fit-dump.py"
D1_LIMIT = 100_000

SCHEMA = (
    "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, body TEXT, n REAL, raw BLOB);\n"
    "CREATE TABLE log (seq INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT);\n"
)


def text_literal(s: str) -> str:
    # D1's export spells newlines as \n inside replace(..., '\n', char(10)).
    quoted = "'" + s.replace("'", "''").replace("\n", "\\n") + "'"
    return f"replace({quoted},'\\n',char(10))" if "\n" in s else quoted


def dump(rows) -> str:
    out = ["PRAGMA defer_foreign_keys=TRUE;\n", SCHEMA]
    for table, cols, values in rows:
        names = ",".join(f'"{c}"' for c in cols)
        out.append(f'INSERT INTO "{table}" ({names}) VALUES({",".join(values)});\n')
    out.append("CREATE TRIGGER log_guard AFTER INSERT ON log BEGIN SELECT 1; END;\n")
    return "".join(out)


def restore(sql: str) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript(sql)
    return db


def fit(sql: str) -> str:
    return subprocess.run(
        [sys.executable, SCRIPT], input=sql, capture_output=True, text=True, check=True
    ).stdout


def test_oversized_rows_become_statements_d1_accepts_and_restore_identically():
    body = "it's ünïcode; with (parens), quotes and\nnewlines " * 6000  # ~330 KB
    blob = bytes(range(256)) * 600  # 150 KB, not valid UTF-8
    rows = [
        (
            "notes",
            ["id", "title", "body", "n", "raw"],
            ["'small'", "'t'", text_literal("short\nbody"), "1.5", "NULL"],
        ),
        (
            "notes",
            ["id", "title", "body", "n", "raw"],
            ["'big'", "'x,y'", text_literal(body), "0.1", "X'" + blob.hex() + "'"],
        ),
        ("log", ["seq", "a", "b"], ["7", text_literal(body[:120_000]), "'after'"]),
    ]
    original = dump(rows)

    fitted = fit(original)

    statements = fitted.splitlines(keepends=True)
    assert max(len(s.encode()) for s in statements) <= D1_LIMIT
    small = next(s for s in original.splitlines(keepends=True) if "'small'" in s)
    assert small in statements  # rows under the limit pass through untouched
    expected, actual = restore(original), restore(fitted)
    for table in ("notes", "log"):
        query = f"SELECT *, typeof(n) FROM {table}" if table == "notes" else "SELECT * FROM log"
        assert actual.execute(query).fetchall() == expected.execute(query).fetchall()
    assert actual.execute("SELECT body FROM notes WHERE id = 'big'").fetchone()[0] == body
    assert actual.execute("SELECT raw FROM notes WHERE id = 'big'").fetchone()[0] == blob
