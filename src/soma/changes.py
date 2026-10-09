"""Local dirty-row receipts, independent of a row's conflict timestamp.

Only supported local writers install these connection-local triggers. Pulls
and hub writes do not, so remote arrivals never become local edits. This is
a bounded set of dirty identities, not a payload or operation log.
"""

import re
import sqlite3


def ensure(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _sync_dirty ("
        "seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, "
        "row_id TEXT NOT NULL, UNIQUE(tbl,row_id))"
    )


def track(conn: sqlite3.Connection) -> None:
    from soma import qi

    ensure(conn)
    tables = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table'"
        )
        if not r[0].startswith(("_", "sqlite_"))
    ]
    for table in tables:
        cols = [
            r[0] for r in conn.execute("SELECT name FROM pragma_table_info(?, 'main')", (table,))
        ]
        if not {"id", "updated_at"} <= set(cols):
            continue
        for event in ("INSERT", "UPDATE"):
            # Identifiers have already passed qi's restricted alphabet.
            conn.execute(
                f"CREATE TEMP TRIGGER {qi(f'_sync_dirty_{table}_{event}')} "
                f"AFTER {event} ON main.{qi(table)} "
                "BEGIN INSERT INTO _sync_dirty(tbl,row_id) "
                f"VALUES ('{table}',NEW.id) ON CONFLICT(tbl,row_id) "
                "DO UPDATE SET seq=excluded.seq; END"
            )


def rename(conn: sqlite3.Connection, old: str, new: str) -> None:
    ensure(conn)
    if old == new:
        return
    # A dropped table can leave receipts under the reused name. Merge those
    # identities with a fresh generation so any in-flight old receipt is stale.
    conn.execute(
        "INSERT INTO _sync_dirty(tbl,row_id) SELECT ?,row_id FROM _sync_dirty WHERE tbl=? "
        "ON CONFLICT(tbl,row_id) DO UPDATE SET seq=excluded.seq",
        (new, old),
    )
    conn.execute("DELETE FROM _sync_dirty WHERE tbl=?", (old,))


def replay_rename(conn: sqlite3.Connection, ddl: str) -> None:
    # Called only after SQLite accepts the DDL (or its idempotent replay).
    # Synced identifiers use the same restricted alphabet as qi().
    ident = r'["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?'
    match = re.fullmatch(
        rf"\s*ALTER\s+TABLE\s+{ident}\s+RENAME\s+TO\s+{ident}\s*;?\s*", ddl, re.IGNORECASE
    )
    if match:
        rename(conn, *match.groups())
