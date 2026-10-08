#!/usr/bin/env python3
"""Rewrite a SQL dump (stdin -> stdout) so every statement fits D1's 100 KB
statement limit, for restoring a hub backup into D1:

    gunzip -c life-....sql.gz | scripts/d1-fit-dump.py > dump.sql
    wrangler d1 execute <new-db> --remote --file dump.sql

D1 stores values up to 2 MB, but its export writes each row as one INSERT,
so a large row cannot be imported as exported (SQLITE_TOOBIG). Such an
INSERT becomes an INSERT with its largest values emptied, followed by
UPDATEs appending them in pieces to the row just inserted. That relies on
last_insert_rowid(), which holds because export dumps create triggers after
all data. Statements under the limit pass through byte for byte.
"""

import re
import sqlite3
import sys

LIMIT = 100_000
PIECE_CHARS = 10_000  # at most 40 KB of UTF-8, 80 KB as hex
PIECE_BYTES = 40_000
INSERT = re.compile(r'INSERT INTO ("(?:[^"]|"")+") \((.*?)\) VALUES\((.*)\);\n?', re.DOTALL)
IDENT = re.compile(r'"(?:[^"]|"")+"')
EMPTY = ("''", "X''")


def split_values(text: str) -> list[str]:
    """Top-level comma-separated expressions of a VALUES list."""
    out, depth, start, quoted, i = [], 0, 0, False, 0
    while i < len(text):
        c = text[i]
        if quoted:
            if c == "'" and text[i + 1 : i + 2] == "'":
                i += 1
            elif c == "'":
                quoted = False
        elif c == "'":
            quoted = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "," and depth == 0:
            out.append(text[start:i])
            start = i + 1
        i += 1
    out.append(text[start:])
    return out


def appends(table: str, col: str, value) -> list[str]:
    if isinstance(value, str):
        pieces = [value[i : i + PIECE_CHARS] for i in range(0, len(value), PIECE_CHARS)]
        sets = [f"{col} || CAST(X'{p.encode().hex()}' AS TEXT)" for p in pieces]
    elif isinstance(value, bytes):
        pieces = [value[i : i + PIECE_BYTES] for i in range(0, len(value), PIECE_BYTES)]
        sets = [f"CAST({col} || X'{p.hex()}' AS BLOB)" for p in pieces]
    else:
        raise SystemExit(f"cannot split a {type(value).__name__} value of {table}.{col}")
    return [f"UPDATE {table} SET {col} = {s} WHERE rowid = last_insert_rowid();\n" for s in sets]


def fit(line: str, db: sqlite3.Connection) -> list[str]:
    m = INSERT.fullmatch(line)
    if not m:
        raise SystemExit(f"a statement over {LIMIT} bytes is not an INSERT: {line[:80]}")
    table, names, values = m.group(1), IDENT.findall(m.group(2)), split_values(m.group(3))
    cols = m.group(2)
    tail = []

    def insert() -> str:
        return f"INSERT INTO {table} ({cols}) VALUES({','.join(values)});\n"

    while len(insert().encode()) > LIMIT:
        i = max(range(len(values)), key=lambda k: len(values[k]))
        if values[i] in EMPTY:
            raise SystemExit(f"cannot fit a row of {table} under {LIMIT} bytes")
        value = db.execute(f"SELECT {values[i]}").fetchone()[0]
        values[i] = "''" if isinstance(value, str) else "X''"
        tail += appends(table, names[i], value)
    return [insert(), *tail]


def main() -> None:
    # Bytes, split on \n only: a bare \r inside a value must not end a line.
    db, out = sqlite3.connect(":memory:"), sys.stdout.buffer
    for raw in sys.stdin.buffer:
        if len(raw) <= LIMIT:
            out.write(raw)
        else:
            out.write("".join(fit(raw.decode(), db)).encode())


if __name__ == "__main__":
    main()
