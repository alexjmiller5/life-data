"""Canonical synced sidebar pin storage; no device preferences or network access."""

import json
import re
from importlib.resources import files

from . import catalog


def manifest():
    return json.loads(files("soma").joinpath("schema/sidebar-pins.json").read_text())


def recognized(conn):
    expected = manifest()
    schema = conn.execute(
        "SELECT sql FROM main.sqlite_master WHERE (type='table' AND name='sidebar_pins') "
        "OR (type='trigger' AND name='sidebar_pins_updated_at') ORDER BY type"
    ).fetchall()
    normalize = lambda sql: re.sub(r"\s+", " ", sql).strip()
    if [normalize(row["sql"]) for row in schema] != [normalize(sql) for sql in expected["ddl"]]:
        return False
    if not all(
        catalog._table_exists(conn, name) for name in ("catalog_tables", "catalog_properties")
    ):
        return False
    table = conn.execute(
        "SELECT * FROM catalog_tables WHERE id='sidebar_pins' AND deleted_at IS NULL"
    ).fetchone()
    props = conn.execute(
        "SELECT * FROM catalog_properties WHERE tbl='sidebar_pins' AND deleted_at IS NULL"
    ).fetchall()
    if not table or any(table[key] != value for key, value in expected["table"].items()):
        return False
    by_id = {row["id"]: row for row in props}
    return len(props) == len(expected["properties"]) and all(
        prop["id"] in by_id
        and all(by_id[prop["id"]][key] == value for key, value in prop.items() if key != "sort")
        for prop in expected["properties"]
    )


def provision(path):
    """Install through normal logged DDL/catalog writes, or verify an existing table."""
    from . import connect

    with connect(path) as conn:
        if catalog._table_exists(conn, "sidebar_pins"):
            if not recognized(conn):
                raise ValueError("Sidebar pin storage collision: existing schema was not changed")
            return
    catalog.ensure_catalog(path)
    expected = manifest()

    def run(conn):
        for sql in expected["ddl"]:
            conn.execute(sql)
            conn.execute("INSERT INTO _schema_log(ddl) VALUES (?)", (sql,))
        for table, rows in [
            ("catalog_tables", [expected["table"]]),
            ("catalog_properties", expected["properties"]),
        ]:
            for row in rows:
                catalog._upsert_in(
                    conn, table, row["id"], {k: v for k, v in row.items() if k != "id"}
                )

    catalog.write(path, run, ddl=True)


def rename(conn, old, new):
    """Copy to the new deterministic ID and tombstone the old identity atomically."""
    from . import NOW

    if not recognized(conn):
        return
    rows = conn.execute("SELECT * FROM sidebar_pins WHERE tbl=?", (old,)).fetchall()
    new_id = "pin:v1:" + new.encode("utf-8").hex()
    if rows and conn.execute("SELECT 1 FROM sidebar_pins WHERE id=?", (new_id,)).fetchone():
        raise ValueError("Sidebar pin destination collision; no table was renamed")
    for original in rows:
        if original["id"] != "pin:v1:" + old.encode("utf-8").hex():
            raise ValueError("Sidebar pin identity is invalid; no table was renamed")
        stamp = conn.execute(
            f"SELECT max({NOW},strftime('%Y-%m-%dT%H:%M:%fZ',?,'+0.001 seconds'))",
            (original["updated_at"],),
        ).fetchone()[0]
        row = dict(original)
        row.update(id=new_id, tbl=new, updated_at=stamp, hub_at=None)
        cols = list(row)
        conn.execute(
            f"INSERT INTO sidebar_pins ({','.join(catalog.qi(c) for c in cols)}) VALUES ({','.join('?' for _ in cols)})",
            list(row.values()),
        )
        conn.execute(
            "UPDATE sidebar_pins SET deleted_at=?,updated_at=? WHERE id=?",
            (stamp, stamp, original["id"]),
        )
