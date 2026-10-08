"""In-memory SQLite with D1's length/parameter/compound-SELECT limits, driven by JSON lines."""

import json
import sqlite3
import sys

db = sqlite3.connect(":memory:", isolation_level=None)
db.row_factory = sqlite3.Row
db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 2_000_000)
db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 99)
db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
db.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 5)


def execute(statement):
    cursor = db.execute(statement["sql"], statement.get("args", []))
    return {
        "results": [dict(row) for row in cursor.fetchall()],
        "columns": [column[0] for column in cursor.description or []],
    }


for line in sys.stdin:
    try:
        request = json.loads(line)
        if "batch" in request:
            db.execute("BEGIN")
            try:
                result = [execute(statement) for statement in request["batch"]]
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        else:
            result = execute(request)
        print(json.dumps({"result": result}), flush=True)
    except sqlite3.Error as error:
        print(json.dumps({"error": str(error)}), flush=True)
