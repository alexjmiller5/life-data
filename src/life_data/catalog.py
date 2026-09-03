"""Catalog engine: typed properties, rules, derivations, provenance.

Pure over a sqlite3 connection. No CLI, no network. The CLI in __init__ calls
into this; nothing here knows about hubs or argv.
"""

import json
import sqlite3
from pathlib import Path

CATALOG_TABLES = {
    "catalog_tables": [
        "kind:text",
        "purpose:text",
        "id_semantics:text",
        "provenance:text",
        "owner:text",
        "consumers:text",
        "description:text",
    ],
    "catalog_properties": [
        "tbl:text",
        "col:text",
        "label:text",
        "sort:integer",
        "type:text",
        "required:integer",
        "default_value:text",
        "options:text",
        "options_sql:text",
        "min_items:integer",
        "max_items:integer",
        "pattern:text",
        "ref_table:text",
        "derived_by:text",
        "inputs:text",
        "immutable:integer",
        "deprecated:integer",
        "description:text",
        "source:text",
        "source_ref:text",
    ],
    "catalog_rules": [
        "scope:text",
        "tbl:text",
        "col:text",
        "kind:text",
        "text:text",
        "sql:text",
        "cmd:text",
        "enforce:integer",
    ],
    "provenance": [
        "tbl:text",
        "row_id:text",
        "col:text",
        "derived_by:text",
        "inputs_hash:text",
        "value_hash:text",
        "source_ref:text",
        "produced_at:text",
    ],
    "catalog_log": ["tbl:text", "row_id:text", "action:text", "payload:text"],
}
ENGINE_TABLES = set(CATALOG_TABLES)

TYPES = {
    "text",
    "number",
    "int",
    "bool",
    "date",
    "datetime",
    "json",
    "select",
    "multi_select",
    "ref",
    "multi_ref",
    "url",
    "email",
    "phone",
}
STORAGE = {
    "text": "TEXT",
    "number": "REAL",
    "int": "INTEGER",
    "bool": "INTEGER",
    "date": "TEXT",
    "datetime": "TEXT",
    "json": "TEXT",
    "select": "TEXT",
    "multi_select": "TEXT",
    "ref": "TEXT",
    "multi_ref": "TEXT",
    "url": "TEXT",
    "email": "TEXT",
    "phone": "TEXT",
}
RULE_KINDS = {"invariant", "doctrine", "audit"}
JSON_COLS = {"options", "inputs", "consumers"}


def _pkg():
    # lazy: the package imports this module
    import life_data

    return life_data


# --- catalog tables ----------------------------------------------------------


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def has_catalog(conn: sqlite3.Connection) -> bool:
    return _table_exists(conn, "catalog_properties")


def ensure_catalog(path: Path) -> None:
    """Create the catalog tables through the logged-DDL path so they sync."""
    pkg = _pkg()
    with pkg.connect(path) as conn:
        missing = [t for t in CATALOG_TABLES if not _table_exists(conn, t)]
    for t in missing:
        pkg.create_table(path, t, CATALOG_TABLES[t])


def _parse(row: dict) -> dict:
    out = dict(row)
    for c in JSON_COLS:
        if c in out and isinstance(out[c], str):
            out[c] = json.loads(out[c])
    return out


def properties(conn: sqlite3.Connection, tbl: str | None = None) -> list[dict]:
    if not has_catalog(conn):
        return []
    sql = "SELECT * FROM catalog_properties WHERE deleted_at IS NULL"
    args: tuple = ()
    if tbl:
        sql += " AND tbl = ?"
        args = (tbl,)
    sql += " ORDER BY sort, col"
    return [_parse(r) for r in conn.execute(sql, args).fetchall()]


def rules(conn: sqlite3.Connection, tbl: str | None = None, kind: str | None = None) -> list[dict]:
    if not has_catalog(conn):
        return []
    sql = "SELECT * FROM catalog_rules WHERE deleted_at IS NULL"
    args: list = []
    if tbl:
        sql += " AND (tbl = ? OR scope = 'estate')"
        args.append(tbl)
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY id"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def cataloged_tables(conn: sqlite3.Connection) -> list[str]:
    if not has_catalog(conn):
        return []
    rows = conn.execute(
        "SELECT DISTINCT tbl FROM catalog_properties WHERE deleted_at IS NULL ORDER BY tbl"
    ).fetchall()
    return [r[0] for r in rows if r[0] not in ENGINE_TABLES]


def _upsert(path: Path, table: str, row_id: str, fields: dict) -> dict:
    """Upsert one catalog row and log it. JSON-encodes list/dict fields."""
    pkg = _pkg()
    ensure_catalog(path)
    enc = {k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in fields.items()}
    with pkg.connect(path) as conn:
        existing = conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (row_id,)).fetchone()
        if existing:
            sets = ", ".join(f"{k} = ?" for k in enc)
            conn.execute(
                f"UPDATE {table} SET {sets}, deleted_at = NULL WHERE id = ?",
                [*enc.values(), row_id],
            )
        else:
            cols = ["id", *enc]
            conn.execute(
                f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                [row_id, *enc.values()],
            )
        conn.execute(
            "INSERT INTO catalog_log (tbl, row_id, action, payload) VALUES (?, ?, 'set', ?)",
            (table, row_id, json.dumps(fields, sort_keys=True)),
        )
        row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    return _parse(dict(row))


def _soft_delete(path: Path, table: str, row_id: str) -> None:
    with _pkg().connect(path) as conn:
        conn.execute(f"UPDATE {table} SET deleted_at = updated_at WHERE id = ?", (row_id,))
        conn.execute(
            "INSERT INTO catalog_log (tbl, row_id, action, payload) VALUES (?, ?, 'rm', NULL)",
            (table, row_id),
        )


def set_property(path: Path, tbl: str, col: str, **fields) -> dict:
    if "type" in fields and fields["type"] not in TYPES:
        raise ValueError(f"unknown type {fields['type']!r}; one of {sorted(TYPES)}")
    if fields.get("derived_by") and not fields["derived_by"].startswith(("sql:", "cmd:")):
        raise ValueError("derived_by must start with 'sql:' or 'cmd:'")
    return _upsert(path, "catalog_properties", f"{tbl}.{col}", {"tbl": tbl, "col": col, **fields})


def rm_property(path: Path, tbl: str, col: str) -> None:
    _soft_delete(path, "catalog_properties", f"{tbl}.{col}")


def set_rule(path: Path, rule_id: str, **fields) -> dict:
    if "kind" in fields and fields["kind"] not in RULE_KINDS:
        raise ValueError(f"unknown kind {fields['kind']!r}; one of {sorted(RULE_KINDS)}")
    return _upsert(path, "catalog_rules", rule_id, fields)


def rm_rule(path: Path, rule_id: str) -> None:
    _soft_delete(path, "catalog_rules", rule_id)


def set_table(path: Path, table_id: str, **fields) -> dict:
    return _upsert(path, "catalog_tables", table_id, fields)
