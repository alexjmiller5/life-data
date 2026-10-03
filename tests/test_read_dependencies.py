"""Check shared adapter expectations against SQLite compiler read metadata.

EXPLAIN compiles each input without evaluating its expressions. Its bytecode is
not parsed: all dependency evidence comes from the SQLite authorizer callback.
Host tests additionally enforce the fixture's unsupported/invalid cases.
"""

import json
import sqlite3
from pathlib import Path

import pytest

FIXTURE = json.loads((Path(__file__).parent / "fixtures/read-dependencies.json").read_text())


@pytest.mark.parametrize(
    "case",
    [case for case in FIXTURE["cases"] if case.get("expected") is not None],
    ids=lambda case: case["name"],
)
def test_dependency_fixture_compiler_reads(case):
    db = sqlite3.connect(":memory:")
    try:
        for sql in FIXTURE["setup"] + case.get("setup", []):
            db.execute(sql)
        tables = {
            name
            for schema, name, kind, *_ in db.execute("PRAGMA table_list")
            if schema == "main" and kind == "table"
        }
        reads = set()

        def authorize(action, name, column, schema, context):
            if action == sqlite3.SQLITE_READ and schema != "temp" and name in tables:
                reads.add(name)
            return sqlite3.SQLITE_OK

        db.set_authorizer(authorize)
        for statement in case["statements"]:
            db.execute("EXPLAIN " + statement["sql"], statement.get("params", []))
        db.set_authorizer(None)
        assert reads == set(case["expected"]["tables"])
        assert db.execute("SELECT id,body FROM items").fetchall() == [("one", "[]")]
        assert db.execute("SELECT * FROM temp._core_write_before").fetchall() == []
    finally:
        db.close()
