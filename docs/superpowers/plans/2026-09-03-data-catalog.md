# Data Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give life-data a catalog of typed properties, enforced rules, derived columns with provenance, and generated docs, enforced on every write path.

**Architecture:** A new pure module `src/life_data/catalog.py` holds the engine (catalog CRUD, the row validator, invariants, derivations, check/audit/infer/doc). The existing `src/life_data/__init__.py` keeps the CLI and sync layer and routes its two write seams (`execute_sql`, `insert_rows`) through a transaction wrapper in the engine. The worker gets a mirror validator in `worker/src/validate.js`, exercised by a shared JSON fixture, and validates pushed rows per row, never per batch.

**Tech Stack:** Python 3.12 stdlib only (sqlite3, json, hashlib, subprocess, re). Worker: Cloudflare Workers JS, tested with `bun test` over a `bun:sqlite` D1 shim. pytest, ruff.

**Spec:** `docs/superpowers/specs/2026-09-03-data-catalog-design.md`

## Global Constraints

- Client: **standard library only, no runtime dependencies.**
- Never invoke uv bare: `just test`, `just check`, `just fmt`.
- Timestamps everywhere: `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (the `NOW` constant).
- Tables created by the product go through `create_table` so the DDL is logged in `_schema_log` and replays to every replica. Underscore-prefixed tables are plumbing and are never logged.
- **No CHECK constraints, no validation triggers.** Validation happens in the write path.
- **No network, no model, no command on the write path.** Invariant SQL is one read-only SELECT; `random(`, `localtime`, `'now'` are rejected at compile.
- **Hub rejects per row and continues.** A batch is never failed by one row.
- Personal data never enters the repo: tests use `Ada`, `Grace`, `pets`, `places`-shaped fixtures with invented values.
- Commit messages: plain, no co-author, no session trailer.
- Every catalog write and every derived write is logged (`catalog_log`, `provenance`).
- Scoping decision recorded here: **the hub runs property checks and provenance verification; SQL invariants run on the client only**, where the transaction and `changed`/`before` temp tables exist. `life check` on every replica and in `life watch` covers invariants for rows that arrived by other paths.

---

## File structure

| File | Responsibility |
|---|---|
| `src/life_data/catalog.py` | **New.** The engine. Catalog schema + CRUD, `validate_row`, transaction wrapper `write()`, invariants (`changed`/`before`/`now`), rules compile, derivations + provenance, `check`, `audit`, `infer`, `doc`. Pure over `sqlite3.Connection`; imports `create_table`, `connect`, `NOW` from the package lazily to avoid a cycle. |
| `src/life_data/__init__.py` | CLI, config, hubs, sync. `execute_sql` and `insert_rows` route writes through `catalog.write()`. New subcommands `property`, `rule`, `table set`, `derive`, `check`, `audit`, `infer`, `doc`. `LocalHub.rows_push` validates per row. `sync()` orders catalog tables first and surfaces rejected rows. |
| `tests/test_catalog.py` | **New.** Engine tests. |
| `tests/test_core.py` | Existing; gains sync-order and rejected-row tests. |
| `tests/fixtures/validation-cases.json` | **New.** Shared conformance fixture, run by pytest and bun test. |
| `worker/src/validate.js` | **New.** Mirror of `validate_row` plus `inputsHash`. Pure. |
| `worker/src/index.js` | `/v1/rows/push` validates per row with rejected list; `GET /v1/catalog`; named exports for tests. |
| `worker/test/d1shim.js` | **New.** `bun:sqlite` wrapped to look like a D1 binding. |
| `worker/test/validate.test.js`, `worker/test/push.test.js` | **New.** Fixture conformance; push rejection + provenance. |
| `justfile` | `test` runs pytest then `bun test` in worker. |
| `AGENTS.md` | Layout and conventions updated. |

---

### Task 1: Catalog tables and CRUD

**Files:**
- Create: `src/life_data/catalog.py`
- Create: `tests/test_catalog.py`
- Modify: `src/life_data/__init__.py` (CLI subcommands `property`, `rule`, `table set`)

**Interfaces:**
- Produces: `ensure_catalog(path)`, `has_catalog(conn) -> bool`, `properties(conn, tbl=None) -> list[dict]` (options parsed to a list of `{v,d,sort}`, `inputs` parsed to a list), `rules(conn, tbl=None, kind=None) -> list[dict]`, `set_property(path, tbl, col, **fields) -> dict`, `rm_property(path, tbl, col)`, `set_rule(path, rule_id, **fields) -> dict`, `rm_rule(path, rule_id)`, `set_table(path, table_id, **fields) -> dict`, constants `CATALOG_TABLES`, `TYPES`, `STORAGE`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_catalog.py
import json
import sqlite3

import pytest

from life_data import connect, create_table, execute_sql, init, insert_rows
from life_data.catalog import (
    ensure_catalog,
    has_catalog,
    properties,
    rm_property,
    rules,
    set_property,
    set_rule,
    set_table,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "life.db")


def test_ensure_catalog_creates_logged_tables(db):
    ensure_catalog(db)
    names = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "catalog_tables",
        "catalog_properties",
        "catalog_rules",
        "provenance",
        "catalog_log",
    } <= names
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert any("catalog_properties" in d for d in ddls)
    ensure_catalog(db)  # idempotent
    assert len([d for d in ddls if "CREATE TABLE catalog_properties" in d]) == 1


def test_has_catalog_false_on_fresh_db(db):
    with connect(db) as conn:
        assert has_catalog(conn) is False
    ensure_catalog(db)
    with connect(db) as conn:
        assert has_catalog(conn) is True


def test_set_property_upserts_and_parses(db):
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        options=[{"v": "want"}, {"v": "been", "d": "confirmed"}],
    )
    set_property(db, "places", "status", description="lowercase")
    with connect(db) as conn:
        props = properties(conn, "places")
    assert len(props) == 1
    p = props[0]
    assert p["id"] == "places.status" and p["type"] == "select" and p["required"] == 1
    assert p["options"][1] == {"v": "been", "d": "confirmed"}
    assert p["description"] == "lowercase"


def test_set_property_rejects_unknown_type(db):
    with pytest.raises(ValueError, match="type"):
        set_property(db, "places", "x", type="blob")


def test_rm_property_soft_deletes(db):
    set_property(db, "places", "status", type="text")
    rm_property(db, "places", "status")
    with connect(db) as conn:
        assert properties(conn, "places") == []
    row = execute_sql(db, "SELECT deleted_at FROM catalog_properties WHERE id='places.status'")[0]
    assert row["deleted_at"] is not None


def test_set_rule_and_set_table(db):
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    set_table(db, "places", kind="table", purpose="somewhere real")
    with connect(db) as conn:
        assert rules(conn, kind="doctrine")[0]["id"] == "estate-soft-delete"
    t = execute_sql(db, "SELECT purpose FROM catalog_tables WHERE id='places'")[0]
    assert t["purpose"] == "somewhere real"


def test_catalog_writes_are_logged(db):
    set_property(db, "places", "status", type="text")
    set_rule(db, "r1", scope="estate", kind="doctrine", text="x")
    log = execute_sql(db, "SELECT tbl, row_id, action FROM catalog_log ORDER BY created_at")
    assert log[0] == {"tbl": "catalog_properties", "row_id": "places.status", "action": "set"}
    assert log[1] == {"tbl": "catalog_rules", "row_id": "r1", "action": "set"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test -- tests/test_catalog.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'life_data.catalog'`

- [ ] **Step 3: Write the catalog module**

```python
# src/life_data/catalog.py
"""Catalog engine: typed properties, rules, derivations, provenance.

Pure over a sqlite3 connection. No CLI, no network. The CLI in __init__ calls
into this; nothing here knows about hubs or argv.
"""

import hashlib
import json
import re
import sqlite3
import subprocess
from dataclasses import dataclass
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
    if "derived_by" in fields and fields["derived_by"]:
        if not fields["derived_by"].startswith(("sql:", "cmd:")):
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
```

- [ ] **Step 4: Wire the CLI subcommands**

In `src/life_data/__init__.py`, add after the `p_table` parser block (before `args = parser.parse_args(argv)`):

```python
    t_set = t_sub.add_parser("set", help="describe a table in the catalog")
    t_set.add_argument("name")
    for f in ("kind", "purpose", "id_semantics", "provenance", "owner", "consumers", "description"):
        t_set.add_argument(f"--{f.replace('_', '-')}", dest=f)
    p_prop = sub.add_parser("property", help="catalog properties (the per-column contract)")
    pr_sub = p_prop.add_subparsers(dest="property_command", required=True)
    pr_set = pr_sub.add_parser("set", help="upsert a property: <table>.<column>")
    pr_set.add_argument("ref")
    pr_set.add_argument("--type", dest="type")
    pr_set.add_argument("--label")
    pr_set.add_argument("--sort", type=int)
    pr_set.add_argument("--required", type=int, choices=(0, 1))
    pr_set.add_argument("--default", dest="default_value")
    pr_set.add_argument("--options", help="JSON array of {v,d,sort} or a comma list of values")
    pr_set.add_argument("--options-sql", dest="options_sql")
    pr_set.add_argument("--min-items", dest="min_items", type=int)
    pr_set.add_argument("--max-items", dest="max_items", type=int)
    pr_set.add_argument("--pattern")
    pr_set.add_argument("--ref-table", dest="ref_table")
    pr_set.add_argument("--derived-by", dest="derived_by")
    pr_set.add_argument("--inputs", help="comma list of columns")
    pr_set.add_argument("--immutable", type=int, choices=(0, 1))
    pr_set.add_argument("--deprecated", type=int, choices=(0, 1))
    pr_set.add_argument("--description")
    pr_set.add_argument("--source")
    pr_set.add_argument("--source-ref", dest="source_ref")
    pr_list = pr_sub.add_parser("list", help="list properties, optionally for one table")
    pr_list.add_argument("table", nargs="?")
    pr_rm = pr_sub.add_parser("rm", help="soft-delete a property: <table>.<column>")
    pr_rm.add_argument("ref")
    p_rule = sub.add_parser("rule", help="catalog rules (invariant, doctrine, audit)")
    ru_sub = p_rule.add_subparsers(dest="rule_command", required=True)
    ru_set = ru_sub.add_parser("set", help="upsert a rule by id")
    ru_set.add_argument("id")
    ru_set.add_argument("--scope", choices=("estate", "table", "column"))
    ru_set.add_argument("--tbl")
    ru_set.add_argument("--col")
    ru_set.add_argument("--kind", choices=("invariant", "doctrine", "audit"))
    ru_set.add_argument("--text")
    ru_set.add_argument("--sql")
    ru_set.add_argument("--cmd")
    ru_set.add_argument("--enforce", type=int, choices=(0, 1))
    ru_list = ru_sub.add_parser("list", help="list rules, optionally for one table")
    ru_list.add_argument("table", nargs="?")
    ru_rm = ru_sub.add_parser("rm", help="soft-delete a rule")
    ru_rm.add_argument("id")
```

And handlers, replacing the existing `elif args.command == "table":` block:

```python
    elif args.command == "table":
        if args.table_command == "create":
            create_table(path, args.name, args.columns)
            print(f"created table {args.name}")
        else:
            fields = {k: v for k, v in vars(args).items()
                      if k in ("kind", "purpose", "id_semantics", "provenance", "owner", "consumers", "description")
                      and v is not None}
            if "consumers" in fields:
                fields["consumers"] = [s.strip() for s in fields["consumers"].split(",")]
            print(json.dumps(catalog.set_table(path, args.name, **fields), indent=2))
    elif args.command == "property":
        if args.property_command == "set":
            tbl, col = args.ref.split(".", 1)
            skip = {"command", "property_command", "ref"}
            fields = {k: v for k, v in vars(args).items() if k not in skip and v is not None}
            if "options" in fields:
                raw = fields["options"].strip()
                fields["options"] = (json.loads(raw) if raw.startswith("[")
                                     else [{"v": s.strip()} for s in raw.split(",")])
            if "inputs" in fields:
                fields["inputs"] = [s.strip() for s in fields["inputs"].split(",")]
            print(json.dumps(catalog.set_property(path, tbl, col, **fields), indent=2))
        elif args.property_command == "list":
            with connect(path) as conn:
                print(json.dumps(catalog.properties(conn, args.table), indent=2))
        else:
            tbl, col = args.ref.split(".", 1)
            catalog.rm_property(path, tbl, col)
            print(f"removed {args.ref}")
    elif args.command == "rule":
        if args.rule_command == "set":
            skip = {"command", "rule_command", "id"}
            fields = {k: v for k, v in vars(args).items() if k not in skip and v is not None}
            print(json.dumps(catalog.set_rule(path, args.id, **fields), indent=2))
        elif args.rule_command == "list":
            with connect(path) as conn:
                print(json.dumps(catalog.rules(conn, args.table), indent=2))
        else:
            catalog.rm_rule(path, args.id)
            print(f"removed {args.id}")
```

Add `from life_data import catalog` at the top of `__init__.py` is a cycle; instead add at module bottom, right before `def main`: `from life_data import catalog  # noqa: E402` (catalog imports the package lazily, so this is safe).

- [ ] **Step 5: Run tests to verify they pass**

Run: `just test -- tests/test_catalog.py -q && just check`
Expected: 7 passed; ruff clean.

- [ ] **Step 6: Commit**

```bash
git add src/life_data/catalog.py src/life_data/__init__.py tests/test_catalog.py
git commit -m "Add catalog tables and property/rule/table CRUD"
```

---

### Task 2: The pure row validator and the shared fixture

**Files:**
- Modify: `src/life_data/catalog.py`
- Create: `tests/fixtures/validation-cases.json`
- Modify: `tests/test_catalog.py`

**Interfaces:**
- Produces: `Violation(tbl, row_id, col, rule, message)` dataclass, `ValidationError(Exception)` with `.violations`, `validate_row(props, before, after, *, in_derive=(), ref_ok=None, extra_options=None) -> list[Violation]`. `in_derive` is a set of column names being written by a derivation. `ref_ok(ref_table, id) -> bool`. `extra_options(prop) -> list[str]`.
- Fixture case shape: `{"name", "properties": [prop...], "before": row|null, "after": row, "in_derive": [cols], "refs": {"table": [ids]}, "extra_options": {"col": [values]}, "expect": [{"col", "rule"}]}`.

- [ ] **Step 1: Write the fixture**

```json
[
  {"name": "unlisted column is unconstrained", "properties": [], "before": null,
   "after": {"id": "a", "anything": "goes"}, "expect": []},
  {"name": "required missing on insert", "properties": [{"tbl": "t", "col": "name", "type": "text", "required": 1}],
   "before": null, "after": {"id": "a", "name": null}, "expect": [{"col": "name", "rule": "required"}]},
  {"name": "required empty string counts as missing", "properties": [{"tbl": "t", "col": "name", "type": "text", "required": 1}],
   "before": null, "after": {"id": "a", "name": ""}, "expect": [{"col": "name", "rule": "required"}]},
  {"name": "select outside options", "properties": [{"tbl": "t", "col": "status", "type": "select", "options": [{"v": "want"}, {"v": "been"}]}],
   "before": null, "after": {"id": "a", "status": "Been"}, "expect": [{"col": "status", "rule": "options"}]},
  {"name": "select inside options", "properties": [{"tbl": "t", "col": "status", "type": "select", "options": [{"v": "want"}, {"v": "been"}]}],
   "before": null, "after": {"id": "a", "status": "been"}, "expect": []},
  {"name": "extra options union", "properties": [{"tbl": "t", "col": "tag", "type": "select", "options": [{"v": "a"}], "options_sql": "SELECT 1"}],
   "before": null, "after": {"id": "a", "tag": "dyn"}, "extra_options": {"tag": ["dyn"]}, "expect": []},
  {"name": "multi_select must be array", "properties": [{"tbl": "t", "col": "tags", "type": "multi_select", "options": [{"v": "a"}]}],
   "before": null, "after": {"id": "a", "tags": "a"}, "expect": [{"col": "tags", "rule": "type"}]},
  {"name": "multi_select element outside options", "properties": [{"tbl": "t", "col": "tags", "type": "multi_select", "options": [{"v": "a"}]}],
   "before": null, "after": {"id": "a", "tags": ["a", "b"]}, "expect": [{"col": "tags", "rule": "options"}]},
  {"name": "multi_select as JSON text is accepted", "properties": [{"tbl": "t", "col": "tags", "type": "multi_select", "options": [{"v": "a"}]}],
   "before": null, "after": {"id": "a", "tags": "[\"a\"]"}, "expect": []},
  {"name": "multi_select max_items", "properties": [{"tbl": "t", "col": "tags", "type": "multi_select", "options": [{"v": "a"}, {"v": "b"}], "max_items": 1}],
   "before": null, "after": {"id": "a", "tags": ["a", "b"]}, "expect": [{"col": "tags", "rule": "max_items"}]},
  {"name": "multi_select min_items", "properties": [{"tbl": "t", "col": "tags", "type": "multi_select", "options": [{"v": "a"}], "min_items": 1, "required": 1}],
   "before": null, "after": {"id": "a", "tags": []}, "expect": [{"col": "tags", "rule": "required"}]},
  {"name": "date format", "properties": [{"tbl": "t", "col": "d", "type": "date"}],
   "before": null, "after": {"id": "a", "d": "2026-9-3"}, "expect": [{"col": "d", "rule": "type"}]},
  {"name": "date ok", "properties": [{"tbl": "t", "col": "d", "type": "date"}],
   "before": null, "after": {"id": "a", "d": "2026-09-03"}, "expect": []},
  {"name": "datetime format", "properties": [{"tbl": "t", "col": "d", "type": "datetime"}],
   "before": null, "after": {"id": "a", "d": "2026-09-03T14:33:13Z"}, "expect": [{"col": "d", "rule": "type"}]},
  {"name": "datetime ok", "properties": [{"tbl": "t", "col": "d", "type": "datetime"}],
   "before": null, "after": {"id": "a", "d": "2026-09-03T14:33:13.538Z"}, "expect": []},
  {"name": "number not numeric", "properties": [{"tbl": "t", "col": "n", "type": "number"}],
   "before": null, "after": {"id": "a", "n": "abc"}, "expect": [{"col": "n", "rule": "type"}]},
  {"name": "int not integral", "properties": [{"tbl": "t", "col": "n", "type": "int"}],
   "before": null, "after": {"id": "a", "n": 1.5}, "expect": [{"col": "n", "rule": "type"}]},
  {"name": "bool must be 0 or 1", "properties": [{"tbl": "t", "col": "b", "type": "bool"}],
   "before": null, "after": {"id": "a", "b": "yes"}, "expect": [{"col": "b", "rule": "type"}]},
  {"name": "json must parse", "properties": [{"tbl": "t", "col": "j", "type": "json"}],
   "before": null, "after": {"id": "a", "j": "{nope"}, "expect": [{"col": "j", "rule": "type"}]},
  {"name": "pattern full match", "properties": [{"tbl": "t", "col": "u", "type": "url", "pattern": "^https://maps\\.app\\.goo\\.gl/.+"}],
   "before": null, "after": {"id": "a", "u": "https://example.com"}, "expect": [{"col": "u", "rule": "pattern"}]},
  {"name": "url must be http(s)", "properties": [{"tbl": "t", "col": "u", "type": "url"}],
   "before": null, "after": {"id": "a", "u": "ftp://x"}, "expect": [{"col": "u", "rule": "type"}]},
  {"name": "email shape", "properties": [{"tbl": "t", "col": "e", "type": "email"}],
   "before": null, "after": {"id": "a", "e": "not-an-email"}, "expect": [{"col": "e", "rule": "type"}]},
  {"name": "ref must exist", "properties": [{"tbl": "t", "col": "p", "type": "ref", "ref_table": "people"}],
   "before": null, "after": {"id": "a", "p": "p9"}, "refs": {"people": ["p1"]}, "expect": [{"col": "p", "rule": "ref"}]},
  {"name": "ref exists", "properties": [{"tbl": "t", "col": "p", "type": "ref", "ref_table": "people"}],
   "before": null, "after": {"id": "a", "p": "p1"}, "refs": {"people": ["p1"]}, "expect": []},
  {"name": "multi_ref every id must exist", "properties": [{"tbl": "t", "col": "ps", "type": "multi_ref", "ref_table": "people"}],
   "before": null, "after": {"id": "a", "ps": ["p1", "p2"]}, "refs": {"people": ["p1"]}, "expect": [{"col": "ps", "rule": "ref"}]},
  {"name": "deprecated non-null rejected", "properties": [{"tbl": "t", "col": "old", "type": "text", "deprecated": 1}],
   "before": null, "after": {"id": "a", "old": "x"}, "expect": [{"col": "old", "rule": "deprecated"}]},
  {"name": "deprecated null is fine", "properties": [{"tbl": "t", "col": "old", "type": "text", "deprecated": 1}],
   "before": null, "after": {"id": "a", "old": null}, "expect": []},
  {"name": "derived column hand-written on insert", "properties": [{"tbl": "t", "col": "genres", "type": "json", "derived_by": "cmd:tmdb", "inputs": ["tmdb_id"]}],
   "before": null, "after": {"id": "a", "genres": "[\"Drama\"]"}, "expect": [{"col": "genres", "rule": "derived"}]},
  {"name": "derived column changed outside derive", "properties": [{"tbl": "t", "col": "genres", "type": "json", "derived_by": "cmd:tmdb", "inputs": ["tmdb_id"]}],
   "before": {"id": "a", "genres": "[\"Drama\"]"}, "after": {"id": "a", "genres": "[\"Comedy\"]"}, "expect": [{"col": "genres", "rule": "derived"}]},
  {"name": "derived column unchanged is fine", "properties": [{"tbl": "t", "col": "genres", "type": "json", "derived_by": "cmd:tmdb", "inputs": ["tmdb_id"]}],
   "before": {"id": "a", "genres": "[\"Drama\"]", "title": "x"}, "after": {"id": "a", "genres": "[\"Drama\"]", "title": "y"}, "expect": []},
  {"name": "derived column written inside derive", "properties": [{"tbl": "t", "col": "genres", "type": "json", "derived_by": "cmd:tmdb", "inputs": ["tmdb_id"]}],
   "before": {"id": "a", "genres": null}, "after": {"id": "a", "genres": "[\"Drama\"]"}, "in_derive": ["genres"], "expect": []},
  {"name": "immutable changed after insert", "properties": [{"tbl": "t", "col": "amount", "type": "number", "immutable": 1}],
   "before": {"id": "a", "amount": 10}, "after": {"id": "a", "amount": 11}, "expect": [{"col": "amount", "rule": "immutable"}]},
  {"name": "immutable set on insert is fine", "properties": [{"tbl": "t", "col": "amount", "type": "number", "immutable": 1}],
   "before": null, "after": {"id": "a", "amount": 10}, "expect": []},
  {"name": "first failing check wins per column", "properties": [{"tbl": "t", "col": "s", "type": "select", "required": 1, "deprecated": 1, "options": [{"v": "a"}]}],
   "before": null, "after": {"id": "a", "s": "zzz"}, "expect": [{"col": "s", "rule": "deprecated"}]}
]
```

- [ ] **Step 2: Write the fixture-driven test and a message test**

Append to `tests/test_catalog.py`:

```python
from pathlib import Path

from life_data.catalog import Violation, validate_row

FIXTURE = Path(__file__).parent / "fixtures" / "validation-cases.json"
CASES = json.loads(FIXTURE.read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_validate_row_conformance(case):
    refs = case.get("refs", {})
    extra = case.get("extra_options", {})
    got = validate_row(
        case["properties"],
        case["before"],
        case["after"],
        in_derive=set(case.get("in_derive", [])),
        ref_ok=lambda t, i: i in refs.get(t, []),
        extra_options=lambda p: extra.get(p["col"], []),
    )
    assert [{"col": v.col, "rule": v.rule} for v in got] == case["expect"]


def test_violation_message_names_allowed_values():
    props = [
        {"tbl": "t", "col": "status", "type": "select", "options": [{"v": "want"}, {"v": "been"}]}
    ]
    v = validate_row(props, None, {"id": "a", "status": "Been"})[0]
    assert isinstance(v, Violation)
    assert v.tbl == "t" and v.row_id == "a"
    assert "want, been" in v.message
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `just test -- tests/test_catalog.py -q`
Expected: FAIL with `ImportError: cannot import name 'Violation'`

- [ ] **Step 4: Implement the validator**

Append to `src/life_data/catalog.py`:

```python
# --- row validation (pure) ---------------------------------------------------


@dataclass
class Violation:
    tbl: str
    row_id: str | None
    col: str | None
    rule: str
    message: str

    def as_dict(self) -> dict:
        return {
            "tbl": self.tbl,
            "row_id": self.row_id,
            "col": self.col,
            "rule": self.rule,
            "message": self.message,
        }


class ValidationError(Exception):
    def __init__(self, violations: list[Violation]):
        self.violations = violations
        super().__init__("\n".join(f"{v.tbl}[{v.row_id}].{v.col}: {v.message}" for v in violations))


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9 ()\-.]{5,}$")


def _empty(v) -> bool:
    return v is None or v == "" or (isinstance(v, list) and len(v) == 0)


def _as_list(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return None
    return v if isinstance(v, list) else None


def _same(a, b) -> bool:
    la, lb = _as_list(a), _as_list(b)
    if la is not None and lb is not None:
        return la == lb
    return a == b


def _allowed(prop: dict, extra_options) -> list[str]:
    vals = [o["v"] for o in (prop.get("options") or [])]
    if prop.get("options_sql") and extra_options:
        vals += [x for x in extra_options(prop) if x not in vals]
    return vals


def validate_row(props, before, after, *, in_derive=(), ref_ok=None, extra_options=None):
    """Spec order: deprecated, derived, immutable, required, type, options,
    cardinality, pattern, ref. First failure per column wins."""
    tbl = props[0]["tbl"] if props else after.get("_tbl", "")
    rid = after.get("id")
    out: list[Violation] = []

    def fail(col, rule, message):
        out.append(Violation(tbl, rid, col, rule, message))

    for p in props:
        col = p["col"]
        v = after.get(col)
        was = before.get(col) if before else None
        changed = (not _empty(v)) if before is None else (not _same(v, was))
        label = p.get("label") or col

        if p.get("deprecated") and not _empty(v):
            fail(col, "deprecated", f"{col} is deprecated. Never write it.")
            continue
        if p.get("derived_by") and changed and col not in in_derive:
            fail(col, "derived", f"{col} is derived by {p['derived_by']}. Run life derive.")
            continue
        if p.get("immutable") and before is not None and changed:
            fail(col, "immutable", f"{col} is set once and never changed.")
            continue
        if p.get("required") and _empty(v):
            fail(col, "required", f"{label} is required.")
            continue
        if _empty(v):
            continue

        t = p.get("type", "text")
        if t in ("number", "int"):
            try:
                n = float(v)
            except (TypeError, ValueError):
                fail(col, "type", f"{label} must be a number.")
                continue
            if t == "int" and n != int(n):
                fail(col, "type", f"{label} must be an integer.")
                continue
        elif t == "bool" and v not in (0, 1, True, False):
            fail(col, "type", f"{label} must be 0 or 1.")
            continue
        elif t == "date" and not (isinstance(v, str) and DATE_RE.match(v)):
            fail(col, "type", f"{label} must be YYYY-MM-DD.")
            continue
        elif t == "datetime" and not (isinstance(v, str) and DATETIME_RE.match(v)):
            fail(col, "type", f"{label} must be ISO-8601 UTC with milliseconds.")
            continue
        elif t == "json":
            try:
                json.loads(v) if isinstance(v, str) else json.dumps(v)
            except (TypeError, ValueError):
                fail(col, "type", f"{label} must be JSON.")
                continue
        elif t == "url" and not (isinstance(v, str) and v.startswith(("http://", "https://"))):
            fail(col, "type", f"{label} must be an http(s) URL.")
            continue
        elif t == "email" and not (isinstance(v, str) and EMAIL_RE.match(v)):
            fail(col, "type", f"{label} must be an email address.")
            continue
        elif t == "phone" and not (isinstance(v, str) and PHONE_RE.match(v)):
            fail(col, "type", f"{label} must be a phone number.")
            continue
        elif t == "select":
            allowed = _allowed(p, extra_options)
            if allowed and v not in allowed:
                fail(
                    col,
                    "options",
                    f"{v!s} is not an option for {col}. Allowed: {', '.join(allowed)}",
                )
                continue
        elif t in ("multi_select", "multi_ref"):
            items = _as_list(v)
            if items is None:
                fail(col, "type", f"{label} must be a JSON array.")
                continue
            if t == "multi_select":
                allowed = _allowed(p, extra_options)
                bad = [x for x in items if allowed and x not in allowed]
                if bad:
                    fail(
                        col,
                        "options",
                        f"Not options for {col}: {', '.join(map(str, bad))}. Allowed: {', '.join(allowed)}",
                    )
                    continue
            if p.get("min_items") and len(items) < p["min_items"]:
                fail(col, "min_items", f"{label} needs at least {p['min_items']}.")
                continue
            if p.get("max_items") and len(items) > p["max_items"]:
                fail(col, "max_items", f"{label} allows at most {p['max_items']}.")
                continue
            if t == "multi_ref" and ref_ok and p.get("ref_table"):
                missing = [x for x in items if not ref_ok(p["ref_table"], x)]
                if missing:
                    fail(col, "ref", f"No {p['ref_table']} row: {', '.join(map(str, missing))}")
                    continue
        elif t == "ref" and ref_ok and p.get("ref_table") and not ref_ok(p["ref_table"], v):
            fail(col, "ref", f"No {p['ref_table']} row with id {v}.")
            continue

        if p.get("pattern") and isinstance(v, str) and not re.fullmatch(p["pattern"], v):
            fail(col, "pattern", f"{label} is not in the expected form.")
            continue
    return out
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `just test -- tests/test_catalog.py -q && just check`
Expected: all fixture cases pass. If a fixture case disagrees with the implementation, the fixture is the contract: fix the code, not the case, unless the case contradicts the spec.

- [ ] **Step 6: Mutation-test one rule**

Temporarily change `if p.get("required") and _empty(v)` to `if False`, run: `just test -- tests/test_catalog.py -q -k required`. Expected: FAIL. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/life_data/catalog.py tests/test_catalog.py tests/fixtures/validation-cases.json
git commit -m "Add pure row validator and shared conformance fixture"
```

---

### Task 3: The write path

**Files:**
- Modify: `src/life_data/catalog.py`
- Modify: `src/life_data/__init__.py:53-85` (`connect`, `execute_sql`, `insert_rows`)
- Modify: `tests/test_catalog.py`

**Interfaces:**
- Produces: `write(path, fn, *, in_derive=()) -> Any` runs `fn(conn)` in one transaction, validates changed rows in cataloged tables, raises `ValidationError` after ROLLBACK. `apply_defaults(conn, tbl, row) -> dict` fills absent columns from `default_value`. `execute_sql` and `insert_rows` keep their signatures; reads bypass the wrapper.
- `connect(path, manual_tx=False)`: `manual_tx=True` opens with `isolation_level=None` so BEGIN/COMMIT are explicit.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_catalog.py`:

```python
from life_data.catalog import ValidationError


def _places(db):
    create_table(db, "places", ["name:text", "status:text", "tags:text", "gmaps_url:text"])
    set_property(db, "places", "name", type="text", required=1)
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        default_value="want",
        options=[{"v": "want"}, {"v": "priority"}, {"v": "been"}],
    )
    set_property(db, "places", "tags", type="multi_select", options=[{"v": "bar"}, {"v": "cafe"}])


def test_insert_violation_rolls_back_whole_statement(db):
    _places(db)
    with pytest.raises(ValidationError) as ei:
        insert_rows(
            db, "places", [{"name": "Casa", "status": "want"}, {"name": "Bad", "status": "Been"}]
        )
    assert ei.value.violations[0].col == "status" and ei.value.violations[0].rule == "options"
    assert execute_sql(db, "SELECT count(*) AS n FROM places")[0]["n"] == 0


def test_update_via_sql_is_validated(db):
    _places(db)
    insert_rows(db, "places", [{"name": "Casa", "status": "want"}])
    with pytest.raises(ValidationError, match="not an option"):
        execute_sql(db, "UPDATE places SET status = 'visited'")
    assert execute_sql(db, "SELECT status FROM places")[0]["status"] == "want"


def test_only_changed_rows_are_validated(db):
    create_table(db, "places", ["name:text", "status:text"])
    insert_rows(db, "places", [{"id": "old", "name": "legacy", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    insert_rows(db, "places", [{"id": "new", "name": "n", "status": "want"}])
    execute_sql(db, "UPDATE places SET name = 'renamed' WHERE id = 'new'")  # legacy row untouched
    assert execute_sql(db, "SELECT name FROM places WHERE id='new'")[0]["name"] == "renamed"
    with pytest.raises(ValidationError):
        execute_sql(
            db, "UPDATE places SET name = 'touch' WHERE id = 'old'"
        )  # touching it forces the fix


def test_defaults_apply_on_insert(db):
    _places(db)
    insert_rows(db, "places", [{"name": "Casa"}])
    assert execute_sql(db, "SELECT status FROM places")[0]["status"] == "want"


def test_sql_default_is_evaluated(db):
    import re

    create_table(db, "tasks", ["title:text", "due:text"])
    set_property(db, "tasks", "due", type="date", default_value="sql:date('now')")
    insert_rows(db, "tasks", [{"title": "x"}])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", execute_sql(db, "SELECT due FROM tasks")[0]["due"])


def test_ref_checks_target_table(db):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": "p1", "name": "Ada"}])
    create_table(db, "links", ["person:text"])
    set_property(db, "links", "person", type="ref", ref_table="people")
    insert_rows(db, "links", [{"person": "p1"}])
    with pytest.raises(ValidationError, match="No people row"):
        insert_rows(db, "links", [{"person": "p9"}])


def test_options_sql_extends_allowlist(db):
    create_table(db, "place_tags", ["name:text"])
    insert_rows(db, "place_tags", [{"name": "sports bar"}])
    create_table(db, "tasks", ["tag:text"])
    set_property(
        db,
        "tasks",
        "tag",
        type="select",
        options=[{"v": "chore"}],
        options_sql="SELECT name FROM place_tags WHERE deleted_at IS NULL",
    )
    insert_rows(db, "tasks", [{"tag": "sports bar"}])
    with pytest.raises(ValidationError):
        insert_rows(db, "tasks", [{"tag": "dive bar"}])


def test_reads_are_not_wrapped(db):
    _places(db)
    assert execute_sql(db, "SELECT 1 AS one") == [{"one": 1}]


def test_uncataloged_table_is_unconstrained(db):
    _places(db)
    create_table(db, "scratch", ["v:text"])
    insert_rows(db, "scratch", [{"v": "anything"}])


def test_engine_tables_are_never_validated_against_themselves(db):
    _places(db)
    set_property(db, "catalog_properties", "type", type="select", options=[{"v": "text"}])
    set_property(
        db, "places", "extra", type="url"
    )  # would fail if catalog_properties were validated
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test -- tests/test_catalog.py -q -k "violation or changed or defaults or ref_checks or options_sql or wrapped or unconstrained or engine_tables"`
Expected: FAIL (no `ValidationError` raised, defaults not applied).

- [ ] **Step 3: Implement the write wrapper**

Append to `src/life_data/catalog.py`:

```python
# --- write path --------------------------------------------------------------


def _ref_ok(conn):
    def ok(ref_table, rid):
        if not _table_exists(conn, ref_table):
            return False
        return (
            conn.execute(
                f"SELECT 1 FROM {ref_table} WHERE id = ? AND deleted_at IS NULL", (rid,)
            ).fetchone()
            is not None
        )

    return ok


def _extra_options(conn):
    def extra(prop):
        return [r[0] for r in conn.execute(prop["options_sql"]).fetchall()]

    return extra


def apply_defaults(conn: sqlite3.Connection, tbl: str, row: dict) -> dict:
    out = dict(row)
    for p in properties(conn, tbl):
        d = p.get("default_value")
        if d is None or p["col"] in out:
            continue
        if d.startswith("sql:"):
            out[p["col"]] = conn.execute(f"SELECT ({d[4:]})").fetchone()[0]
        else:
            out[p["col"]] = d
    return out


def write(path: Path, fn, *, in_derive=()):
    """Run fn(conn) in one transaction; validate every changed row in every
    cataloged table; ROLLBACK and raise ValidationError on any violation."""
    pkg = _pkg()
    conn = pkg.connect(path, manual_tx=True)
    try:
        tables = [t for t in cataloged_tables(conn) if _table_exists(conn, t)]
        conn.execute("BEGIN")
        t0 = conn.execute(f"SELECT {pkg.NOW}").fetchone()[0]
        marks = {}
        for t in tables:
            # ponytail: whole-table snapshot per write; scope by rowid past ~1M rows
            conn.execute(f"CREATE TEMP TABLE _before_{t} AS SELECT rowid AS _rowid, * FROM {t}")
            marks[t] = conn.execute(f"SELECT coalesce(max(rowid), 0) FROM {t}").fetchone()[0]
        try:
            result = fn(conn)
            violations = _validate_changed(conn, marks, t0, set(in_derive))
        except Exception:
            conn.execute("ROLLBACK")
            raise
        if violations:
            conn.execute("ROLLBACK")
            raise ValidationError(violations)
        conn.execute("COMMIT")
        return result
    finally:
        conn.close()


def _validate_changed(conn, marks, t0, in_derive) -> list[Violation]:
    out: list[Violation] = []
    for t, max_rowid in marks.items():
        if not _table_exists(conn, t):
            continue  # fn dropped it
        rows = conn.execute(
            f"SELECT * FROM {t} WHERE rowid > ? OR updated_at >= ?", (max_rowid, t0)
        ).fetchall()
        if not rows:
            continue
        props = properties(conn, t)
        for r in rows:
            after = dict(r)
            b = conn.execute(f"SELECT * FROM _before_{t} WHERE id = ?", (after["id"],)).fetchone()
            before = dict(b) if b else None
            if before:
                before.pop("_rowid", None)
            out += validate_row(
                props,
                before,
                after,
                in_derive=in_derive,
                ref_ok=_ref_ok(conn),
                extra_options=_extra_options(conn),
            )
    return out
```

- [ ] **Step 4: Route the seams through it**

In `src/life_data/__init__.py`, replace `connect`, `execute_sql`, `insert_rows`:

```python
READ_KEYWORDS = {"SELECT", "PRAGMA", "EXPLAIN", "WITH", "VALUES"}


def connect(path: Path, manual_tx: bool = False) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None if manual_tx else "")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _first_word(sql: str) -> str:
    return sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""


def execute_sql(path: Path, sql: str) -> list[dict]:
    if _first_word(sql) in READ_KEYWORDS:
        with connect(path) as conn:
            return [dict(r) for r in conn.execute(sql).fetchall()]

    def run(conn):
        rows = [dict(r) for r in conn.execute(sql).fetchall()]
        if _first_word(sql) in DDL_KEYWORDS:
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (sql,))
        return rows

    return catalog.write(path, run)


def insert_rows(path: Path, table: str, rows: list[dict]) -> int:
    def run(conn):
        for row in rows:
            row = catalog.apply_defaults(conn, table, row)
            cols = list(row)
            values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]
            placeholders = ", ".join("?" for _ in cols)
            conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})", values)
        return len(rows)

    return catalog.write(path, run)
```

Move `from life_data import catalog  # noqa: E402` to directly below the `PLUMBING` constant (module top, after constants) so `execute_sql` sees it. `catalog.py` only touches the package lazily inside functions, so the import order is safe.

In `main()`, wrap the `sql`/`insert` handlers so a `ValidationError` prints and exits 1:

```python
    try:
        return _dispatch(args, path)
    except catalog.ValidationError as e:
        print(json.dumps({"rejected": [v.as_dict() for v in e.violations]}, indent=2), file=sys.stderr)
        return 1
```

Rename the big `if/elif` chain into `def _dispatch(args, path) -> int` returning 0 at the end.

- [ ] **Step 5: Run the full suite**

Run: `just test -q && just check`
Expected: all pass, including the pre-existing `test_core.py` (its `create_table` path now goes through `write()` with no cataloged tables, which is a no-op wrapper).

- [ ] **Step 6: Mutation-test the rollback**

Change `conn.execute("ROLLBACK")` after `if violations` to `pass`. Run `just test -- -q -k rolls_back`. Expected: FAIL (count is 1, not 0). Revert.

- [ ] **Step 7: Commit**

```bash
git add src/life_data/catalog.py src/life_data/__init__.py tests/test_catalog.py
git commit -m "Validate changed rows in the write path; defaults on insert"
```

---

### Task 4: Invariants, `changed`/`before`/`now`, rules compile

**Files:**
- Modify: `src/life_data/catalog.py`
- Modify: `tests/test_catalog.py`

**Interfaces:**
- Produces: `check_rule_sql(sql)` raises `ValueError` on `random(`, `localtime`, `'now'`; `compile_sql(conn, sql)` raises `ValueError` when SQLite cannot prepare `SELECT * FROM (<sql>) LIMIT 0`; `run_invariant(conn, rule, changed_ids=None, now=None) -> list[dict]` (creates temp tables `changed`, `before`, `now(ts)` when the rule references them); `compile_all(conn)` compiles every invariant and every `sql:` derivation. `set_rule` and `set_property` compile before writing. `write()` runs `enforce=1` invariants for touched tables and compiles all rules after a DDL statement.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_catalog.py`:

```python
from life_data.catalog import check_rule_sql, compile_sql, run_invariant


def test_rule_sql_rejects_nondeterminism():
    for bad in ("SELECT random()", "SELECT datetime('now')", "SELECT date('now','localtime')"):
        with pytest.raises(ValueError):
            check_rule_sql(bad)
    check_rule_sql("SELECT id FROM t WHERE x > (SELECT ts FROM now)")


def test_set_rule_compiles_invariant(db):
    with pytest.raises(ValueError, match="no such table"):
        set_rule(
            db,
            "bad",
            scope="table",
            tbl="places",
            kind="invariant",
            enforce=1,
            sql="SELECT id FROM nope",
        )


def test_enforced_invariant_blocks_write(db):
    create_table(db, "places", ["category:text", "tags:text"])
    set_property(db, "places", "tags", type="multi_select", options=[{"v": "bar"}, {"v": "cafe"}])
    set_property(db, "places", "category", type="select", options=[{"v": "bar"}, {"v": "cafe"}])
    set_rule(
        db,
        "cat-in-tags",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="Category must be one of the tags.",
        sql="SELECT id FROM places WHERE deleted_at IS NULL AND category IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = places.category)",
    )
    insert_rows(db, "places", [{"category": "bar", "tags": ["bar"]}])
    with pytest.raises(ValidationError, match="Category must be one of the tags"):
        insert_rows(db, "places", [{"category": "cafe", "tags": ["bar"]}])


def test_unenforced_invariant_does_not_block(db):
    create_table(db, "places", ["category:text", "tags:text"])
    set_property(db, "places", "category", type="text")
    set_rule(
        db,
        "cat-in-tags",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT id FROM places WHERE category = 'zzz'",
    )
    insert_rows(db, "places", [{"category": "zzz", "tags": "[]"}])


def test_transition_rule_uses_before_and_changed(db):
    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}, {"v": "been"}])
    set_rule(
        db,
        "no-unbeen",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="A been place never goes back to want.",
        sql="SELECT c.id FROM changed c JOIN before b ON b.id = c.id "
        "WHERE b.status = 'been' AND c.status = 'want'",
    )
    insert_rows(db, "places", [{"id": "x", "status": "want"}])
    execute_sql(db, "UPDATE places SET status = 'been' WHERE id = 'x'")
    with pytest.raises(ValidationError, match="never goes back"):
        execute_sql(db, "UPDATE places SET status = 'want' WHERE id = 'x'")


def test_now_is_injected_not_read(db):
    create_table(db, "tasks", ["due:text"])
    set_property(db, "tasks", "due", type="date")
    set_rule(
        db,
        "not-past",
        scope="table",
        tbl="tasks",
        kind="invariant",
        enforce=0,
        text="due in the past",
        sql="SELECT id FROM tasks WHERE due < substr((SELECT ts FROM now), 1, 10)",
    )
    insert_rows(db, "tasks", [{"id": "a", "due": "2001-01-01"}])
    with connect(db) as conn:
        rule = rules(conn, kind="invariant")[0]
        assert run_invariant(conn, rule, now="2000-01-01T00:00:00.000Z") == []
        assert [r["id"] for r in run_invariant(conn, rule, now="2026-01-01T00:00:00.000Z")] == ["a"]


def test_ddl_recompiles_rules(db):
    create_table(db, "places", ["category:text"])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM places WHERE category = 'z'",
    )
    with pytest.raises(ValidationError, match="no longer compiles"):
        execute_sql(db, "ALTER TABLE places RENAME COLUMN category TO cat")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test -- tests/test_catalog.py -q -k "rule or invariant or transition or now_is or recompiles"`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement**

Append to `src/life_data/catalog.py`:

```python
# --- invariants --------------------------------------------------------------

FORBIDDEN = re.compile(r"random\s*\(|localtime|'now'", re.IGNORECASE)


def check_rule_sql(sql: str) -> None:
    if not sql or _first(sql) != "SELECT":
        raise ValueError("rule sql must be a single SELECT")
    if FORBIDDEN.search(sql):
        raise ValueError(
            "rule sql may not use random(), localtime, or 'now' (use (SELECT ts FROM now))"
        )


def _first(sql: str) -> str:
    return sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""


def _uses(sql: str, name: str) -> bool:
    return re.search(rf"\b{name}\b", sql, re.IGNORECASE) is not None


def _with_context(conn, sql, changed_ids, now, tbl):
    """Create the temp tables a rule may reference; return a cleanup fn."""
    made = []
    if _uses(sql, "now"):
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS now (ts TEXT)")
        conn.execute("DELETE FROM now")
        conn.execute(
            "INSERT INTO now (ts) VALUES (?)",
            (now or conn.execute(f"SELECT {_pkg().NOW}").fetchone()[0],),
        )
        made.append("now")
    if tbl and (_uses(sql, "changed") or _uses(sql, "before")):
        ids = list(changed_ids or [])
        ph = ", ".join("?" for _ in ids) or "NULL"
        conn.execute("DROP TABLE IF EXISTS changed")
        conn.execute(f"CREATE TEMP TABLE changed AS SELECT * FROM {tbl} WHERE id IN ({ph})", ids)
        conn.execute("DROP TABLE IF EXISTS before")
        if _table_exists_temp(conn, f"_before_{tbl}"):
            conn.execute(
                f"CREATE TEMP TABLE before AS SELECT * FROM _before_{tbl} WHERE id IN ({ph})", ids
            )
        else:
            conn.execute(f"CREATE TEMP TABLE before AS SELECT * FROM {tbl} WHERE 0")
        made += ["changed", "before"]

    def cleanup():
        for t in made:
            conn.execute(f"DROP TABLE IF EXISTS {t}")

    return cleanup


def _table_exists_temp(conn, name) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_temp_master WHERE name = ?", (name,)).fetchone()
        is not None
    )


def compile_sql(conn: sqlite3.Connection, sql: str, tbl: str | None = None) -> None:
    cleanup = _with_context(conn, sql, [], None, tbl)
    try:
        conn.execute(f"SELECT * FROM ({sql}) LIMIT 0")
    except sqlite3.Error as e:
        raise ValueError(f"sql does not compile: {e}") from e
    finally:
        cleanup()


def run_invariant(conn, rule: dict, changed_ids=None, now=None) -> list[dict]:
    cleanup = _with_context(conn, rule["sql"], changed_ids, now, rule.get("tbl"))
    try:
        return [dict(r) for r in conn.execute(rule["sql"]).fetchall()]
    finally:
        cleanup()


def compile_all(conn: sqlite3.Connection) -> list[str]:
    """Compile every invariant and sql: derivation. Returns the ids that fail."""
    bad = []
    for r in rules(conn, kind="invariant"):
        try:
            compile_sql(conn, r["sql"], r.get("tbl"))
        except ValueError:
            bad.append(r["id"])
    for p in properties(conn):
        d = p.get("derived_by") or ""
        if d.startswith("sql:") and _table_exists(conn, p["tbl"]):
            try:
                conn.execute(f"SELECT ({d[4:]}) FROM {p['tbl']} LIMIT 0")
            except sqlite3.Error:
                bad.append(p["id"])
    return bad
```

Update `set_rule` to compile invariants, and `set_property` to compile `sql:` derivations, before upserting:

```python
def set_rule(path: Path, rule_id: str, **fields) -> dict:
    if "kind" in fields and fields["kind"] not in RULE_KINDS:
        raise ValueError(f"unknown kind {fields['kind']!r}; one of {sorted(RULE_KINDS)}")
    if fields.get("sql"):
        check_rule_sql(fields["sql"])
        with _pkg().connect(path) as conn:
            compile_sql(conn, fields["sql"], fields.get("tbl"))
    return _upsert(path, "catalog_rules", rule_id, fields)
```

and in `set_property`, after the `derived_by` prefix check:

```python
    d = fields.get("derived_by") or ""
    if d.startswith("sql:"):
        with _pkg().connect(path) as conn:
            if _table_exists(conn, tbl):
                try:
                    conn.execute(f"SELECT ({d[4:]}) FROM {tbl} LIMIT 0")
                except sqlite3.Error as e:
                    raise ValueError(f"derivation does not compile: {e}") from e
```

Extend `_validate_changed` to run enforced invariants and recompile after DDL. Replace its body's tail and add a DDL flag to `write`:

```python
def write(path: Path, fn, *, in_derive=(), ddl: bool = False):
    ...  (same as Task 3, but:)
            result = fn(conn)
            violations = _validate_changed(conn, marks, t0, set(in_derive))
            if ddl:
                for rid in compile_all(conn):
                    violations.append(Violation("catalog", rid, None, "compile",
                                                f"{rid} no longer compiles after this DDL."))
    ...


def _validate_changed(conn, marks, t0, in_derive) -> list[Violation]:
    out: list[Violation] = []
    for t, max_rowid in marks.items():
        ... (as Task 3) ...
        changed_ids = [r["id"] for r in rows]
        for rule in rules(conn, tbl=t, kind="invariant"):
            if not rule.get("enforce") or rule.get("tbl") != t:
                continue
            hits = run_invariant(conn, rule, changed_ids=changed_ids, now=t0)
            for h in hits:
                out.append(Violation(t, h.get("id"), rule.get("col"), rule["id"], rule["text"]))
    return out
```

In `__init__.execute_sql`, pass `ddl=_first_word(sql) in DDL_KEYWORDS` to `catalog.write`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `just test -q && just check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/life_data/catalog.py src/life_data/__init__.py tests/test_catalog.py
git commit -m "Invariants with changed/before/now, rules compile on catalog edits and DDL"
```

---

### Task 5: `life check` and the watch hook

**Files:**
- Modify: `src/life_data/catalog.py`
- Modify: `src/life_data/__init__.py` (`check` subcommand, `watch` loop)
- Modify: `tests/test_catalog.py`

**Interfaces:**
- Produces: `check(path, as_of=None) -> list[dict]` (every property violation whole-table, every invariant regardless of `enforce`, and, after Task 6, staleness and underived). `life check` prints JSON, exit 1 if non-empty. `watch()` prints `check` findings to stderr whenever the db changed.

- [ ] **Step 1: Write the failing tests**

```python
from life_data.catalog import check


def test_check_reports_legacy_violations_and_unenforced_rules(db):
    create_table(db, "places", ["status:text"])
    insert_rows(db, "places", [{"id": "old", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="no old",
        sql="SELECT id FROM places WHERE id = 'old'",
    )
    findings = check(db)
    assert {(f["row_id"], f["rule"]) for f in findings} == {("old", "options"), ("old", "r")}


def test_cli_check_exit_code(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    from life_data import main

    main(["init"])
    main(["table", "create", "pets", "name:text"])
    assert main(["check"]) == 0
    main(["property", "set", "pets.name", "--type", "select", "--options", "cat,dog"])
    import sqlite3 as s

    s.connect(tmp_path / "life.db").execute(
        "INSERT INTO pets (name) VALUES ('rat')"
    ).connection.commit()
    assert main(["check"]) == 1
    assert json.loads(capsys.readouterr().out)[0]["rule"] == "options"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test -- tests/test_catalog.py -q -k check`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement**

Append to `src/life_data/catalog.py`:

```python
# --- check -------------------------------------------------------------------


def check(path: Path, as_of: str | None = None) -> list[dict]:
    pkg = _pkg()
    out: list[Violation] = []
    with pkg.connect(path) as conn:
        for t in cataloged_tables(conn):
            if not _table_exists(conn, t):
                continue
            props = properties(conn, t)
            for r in conn.execute(f"SELECT * FROM {t} WHERE deleted_at IS NULL").fetchall():
                out += validate_row(
                    props,
                    dict(r),
                    dict(r),
                    in_derive={p["col"] for p in props},
                    ref_ok=_ref_ok(conn),
                    extra_options=_extra_options(conn),
                )
        for rule in rules(conn, kind="invariant"):
            for h in run_invariant(conn, rule, changed_ids=[], now=as_of):
                out.append(
                    Violation(
                        rule.get("tbl") or "estate",
                        h.get("id"),
                        rule.get("col"),
                        rule["id"],
                        rule["text"],
                    )
                )
    return [v.as_dict() for v in out]
```

Note `before=after` and `in_derive=all` in the whole-table pass: `check` judges *state*, so immutable/derived transition checks do not apply; options/required/type/ref/pattern do.

CLI: add `p_check = sub.add_parser("check", ...)` with `--as-of`; handler:

```python
    elif args.command == "check":
        findings = catalog.check(path, as_of=args.as_of)
        print(json.dumps(findings, indent=2))
        return 1 if findings else 0
```

In `watch()`, after a successful `sync` when `changed` is true:

```python
            if changed:
                findings = catalog.check(path)
                if findings:
                    print(json.dumps({"check": findings}), file=sys.stderr, flush=True)
```

- [ ] **Step 4: Run tests, commit**

Run: `just test -q && just check`

```bash
git add src/life_data/catalog.py src/life_data/__init__.py tests/test_catalog.py
git commit -m "Add life check; watch reports drift"
```

---

### Task 6: Derivations and provenance

**Files:**
- Modify: `src/life_data/catalog.py`
- Modify: `src/life_data/__init__.py` (`derive` subcommand, config `commands`, sync table order)
- Modify: `tests/test_catalog.py`, `tests/test_core.py`

**Interfaces:**
- Produces: `inputs_hash(conn, tbl, row_id, inputs) -> str` = sha256 of `SELECT json_array(CAST(c1 AS TEXT), ...) FROM tbl WHERE id=?` text, and `value_hash(conn, tbl, row_id, col) -> str` = sha256 of `SELECT CAST(col AS TEXT)` (empty string for NULL). Provenance stores both: `inputs_hash` says what the value was computed from, `value_hash` binds the value itself so a hand edit with unchanged inputs is still detectable. `derive(path, tbl, col, where=None, commands=None) -> int` writes values through `write(..., in_derive={cols})` and upserts `provenance`. `stale(conn) -> list[Violation]` and `underived(conn) -> list[Violation]` feed `check`. `_user_tables` orders `catalog_*` and `provenance` first.
- Command protocol: stdin `{"tbl","id","inputs":{...}}`, stdout JSON object; keys naming derived columns that declare the same `cmd:<name>` are written; optional `_source_ref` is stored.

- [ ] **Step 1: Write the failing tests**

```python
from life_data.catalog import derive, inputs_hash, value_hash


def _movies(db):
    create_table(db, "movies", ["title:text", "tmdb_id:text", "genres:text", "slug:text"])
    set_property(db, "movies", "tmdb_id", type="text", required=1)
    set_property(db, "movies", "genres", type="json", derived_by="cmd:tmdb", inputs=["tmdb_id"])
    set_property(
        db,
        "movies",
        "slug",
        type="text",
        derived_by="sql:lower(replace(title, ' ', '-'))",
        inputs=["title"],
    )


def test_sql_derivation_writes_value_and_provenance(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "Blade Runner", "tmdb_id": "78"}])
    assert derive(db, "movies", "slug") == 1
    assert execute_sql(db, "SELECT slug FROM movies")[0]["slug"] == "blade-runner"
    prov = execute_sql(db, "SELECT * FROM provenance WHERE id = 'movies:m1:slug'")[0]
    with connect(db) as conn:
        assert prov["inputs_hash"] == inputs_hash(conn, "movies", "m1", ["title"])
        assert prov["value_hash"] == value_hash(conn, "movies", "m1", "slug")


def test_cmd_derivation_runs_command_with_inputs(db, tmp_path):
    _movies(db)
    script = tmp_path / "tmdb.py"
    script.write_text(
        "import json,sys\nd=json.load(sys.stdin)\n"
        "print(json.dumps({'genres': ['Sci-Fi'], '_source_ref': 'tmdb:'+d['inputs']['tmdb_id']}))\n"
    )
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    assert derive(db, "movies", "genres", commands={"tmdb": f"python3 {script}"}) == 1
    assert json.loads(execute_sql(db, "SELECT genres FROM movies")[0]["genres"]) == ["Sci-Fi"]
    assert execute_sql(db, "SELECT source_ref FROM provenance")[0]["source_ref"] == "tmdb:78"


def test_hand_edit_to_derived_column_is_rejected(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    derive(db, "movies", "slug")
    with pytest.raises(ValidationError, match="derived"):
        execute_sql(db, "UPDATE movies SET slug = 'hand' WHERE id = 'm1'")


def test_check_reports_stale_and_underived(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    derive(db, "movies", "slug")
    execute_sql(db, "UPDATE movies SET title = 'y' WHERE id = 'm1'")  # input changed
    rules_hit = {(f["col"], f["rule"]) for f in check(db)}
    assert ("slug", "stale") in rules_hit and ("genres", "underived") in rules_hit


def test_cmd_derived_column_cannot_be_required(db):
    create_table(db, "movies", ["genres:text"])
    with pytest.raises(ValueError, match="required"):
        set_property(
            db, "movies", "genres", type="json", required=1, derived_by="cmd:tmdb", inputs=[]
        )


def test_derive_where_filters(db):
    _movies(db)
    insert_rows(
        db,
        "movies",
        [{"id": "m1", "title": "a", "tmdb_id": "1"}, {"id": "m2", "title": "b", "tmdb_id": "2"}],
    )
    assert derive(db, "movies", "slug", where="id = 'm2'") == 1
    assert execute_sql(db, "SELECT slug FROM movies WHERE id='m1'")[0]["slug"] is None
```

And in `tests/test_core.py`:

```python
def test_sync_pushes_catalog_and_provenance_before_data(db, hub, monkeypatch):
    from life_data import _user_tables
    from life_data.catalog import ensure_catalog

    _mk_people(db, ["Ada"])
    ensure_catalog(db)
    order = _user_tables(db)
    assert order.index("provenance") < order.index("people")
    assert order.index("catalog_properties") < order.index("people")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test -q -k "deriv or stale or provenance"`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement**

Append to `src/life_data/catalog.py`:

```python
# --- derivations & provenance ------------------------------------------------


def inputs_hash(conn, tbl: str, row_id: str, inputs: list[str]) -> str:
    """Hash the inputs as SQLite renders them, so Python and the hub agree byte for byte."""
    casts = ", ".join(f"CAST({c} AS TEXT)" for c in inputs) or "NULL"
    text = conn.execute(
        f"SELECT json_array({casts}) FROM {tbl} WHERE id = ?", (row_id,)
    ).fetchone()[0]
    return hashlib.sha256(text.encode()).hexdigest()


def value_hash(conn, tbl: str, row_id: str, col: str) -> str:
    text = conn.execute(
        f"SELECT coalesce(CAST({col} AS TEXT), '') FROM {tbl} WHERE id = ?", (row_id,)
    ).fetchone()[0]
    return hashlib.sha256(text.encode()).hexdigest()


def _run_command(cmd: str, payload: dict) -> dict:
    out = subprocess.run(
        cmd, shell=True, input=json.dumps(payload), capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise RuntimeError(f"derivation command failed: {out.stderr.strip()[:500]}")
    result = json.loads(out.stdout or "{}")
    if not isinstance(result, dict):
        raise RuntimeError("derivation command must print a JSON object")
    return result


def derive(
    path: Path, tbl: str, col: str, where: str | None = None, commands: dict | None = None
) -> int:
    pkg = _pkg()
    with pkg.connect(path) as conn:
        target = next((p for p in properties(conn, tbl) if p["col"] == col), None)
        if not target or not target.get("derived_by"):
            raise ValueError(f"{tbl}.{col} is not a derived property")
        siblings = [p for p in properties(conn, tbl) if p.get("derived_by") == target["derived_by"]]
        cols = [p["col"] for p in siblings]
        inputs = target.get("inputs") or []
        ids = [
            r[0]
            for r in conn.execute(
                f"SELECT id FROM {tbl} WHERE deleted_at IS NULL"
                + (f" AND ({where})" if where else "")
            ).fetchall()
        ]
    d = target["derived_by"]

    def fn(conn):
        count = 0
        for rid in ids:
            if d.startswith("sql:"):
                values = {
                    col: conn.execute(
                        f"SELECT ({d[4:]}) FROM {tbl} WHERE id = ?", (rid,)
                    ).fetchone()[0]
                }
                source_ref = None
            else:
                name = d[4:]
                cmd = (commands or {}).get(name)
                if not cmd:
                    raise RuntimeError(
                        f"no command configured for derivation {name!r} (config.json: commands)"
                    )
                row = conn.execute(f"SELECT * FROM {tbl} WHERE id = ?", (rid,)).fetchone()
                result = _run_command(
                    cmd, {"tbl": tbl, "id": rid, "inputs": {c: row[c] for c in inputs}}
                )
                source_ref = result.pop("_source_ref", None)
                values = {k: v for k, v in result.items() if k in cols}
            sets = ", ".join(f"{k} = ?" for k in values)
            vals = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in values.values()]
            conn.execute(f"UPDATE {tbl} SET {sets} WHERE id = ?", [*vals, rid])
            h = inputs_hash(conn, tbl, rid, inputs)
            now = conn.execute(f"SELECT {pkg.NOW}").fetchone()[0]
            for k in values:
                conn.execute(
                    "INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash, source_ref, produced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET derived_by = excluded.derived_by, "
                    "inputs_hash = excluded.inputs_hash, value_hash = excluded.value_hash, source_ref = excluded.source_ref, "
                    "produced_at = excluded.produced_at, deleted_at = NULL",
                    (
                        f"{tbl}:{rid}:{k}",
                        tbl,
                        rid,
                        k,
                        d,
                        h,
                        value_hash(conn, tbl, rid, k),
                        source_ref,
                        now,
                    ),
                )
            count += 1
        return count

    # one transaction for the whole run: one snapshot, all-or-nothing
    return write(path, fn, in_derive=set(cols))


def stale(conn) -> list[Violation]:
    out = []
    for p in properties(conn):
        if not p.get("derived_by") or not _table_exists(conn, p["tbl"]):
            continue
        rows = conn.execute(
            "SELECT pr.row_id, pr.inputs_hash FROM provenance pr WHERE pr.tbl = ? AND pr.col = ? AND pr.deleted_at IS NULL",
            (p["tbl"], p["col"]),
        ).fetchall()
        for r in rows:
            if inputs_hash(conn, p["tbl"], r["row_id"], p.get("inputs") or []) != r["inputs_hash"]:
                out.append(
                    Violation(
                        p["tbl"],
                        r["row_id"],
                        p["col"],
                        "stale",
                        f"{p['col']} was derived from inputs that have since changed.",
                    )
                )
    return out


def underived(conn) -> list[Violation]:
    out = []
    for p in properties(conn):
        if not p.get("derived_by") or not _table_exists(conn, p["tbl"]):
            continue
        rows = conn.execute(
            f"SELECT t.id FROM {p['tbl']} t WHERE t.deleted_at IS NULL AND NOT EXISTS "
            "(SELECT 1 FROM provenance pr WHERE pr.tbl = ? AND pr.col = ? AND pr.row_id = t.id AND pr.deleted_at IS NULL)",
            (p["tbl"], p["col"]),
        ).fetchall()
        for r in rows:
            out.append(
                Violation(
                    p["tbl"], r["id"], p["col"], "underived", f"{p['col']} has not been derived."
                )
            )
    return out
```

In `set_property`, after the `derived_by` prefix check, add the insert-time rule from the spec:

```python
if fields.get("required") and str(fields.get("derived_by") or "").startswith("cmd:"):
    raise ValueError(
        "a cmd-derived column cannot be required: the row is valid but incomplete until derived"
    )
```

Add `out += stale(conn) + underived(conn)` inside `check()` before returning. In `write()`'s `_validate_changed`, the `in_derive` set already exempts derived columns for derive calls.

In `__init__.py`:

```python
def _user_tables(path: Path) -> list[str]:
    rows = execute_sql(path, "SELECT name FROM sqlite_master WHERE type = 'table'")
    names = [r["name"] for r in rows if not r["name"].startswith(("_", "sqlite_"))]
    first = [n for n in names if n.startswith("catalog_") or n == "provenance"]
    return sorted(first) + sorted(n for n in names if n not in first)
```

`load_config`: `cfg.setdefault("commands", {})`. CLI:

```python
    p_derive = sub.add_parser("derive", help="run a derivation: <table>.<column>")
    p_derive.add_argument("ref")
    p_derive.add_argument("--where", help="SQL predicate selecting rows")
    ...
    elif args.command == "derive":
        tbl, col = args.ref.split(".", 1)
        n = catalog.derive(path, tbl, col, where=args.where, commands=load_config().get("commands"))
        print(f"derived {args.ref} for {n} rows")
```

- [ ] **Step 4: Run tests, commit**

Run: `just test -q && just check`

```bash
git add src/life_data/catalog.py src/life_data/__init__.py tests/test_catalog.py tests/test_core.py
git commit -m "Derivations with provenance; stale and underived in check; catalog syncs first"
```

---

### Task 7: LocalHub per-row rejection and rejected rows surfaced by sync

**Files:**
- Modify: `src/life_data/__init__.py` (`LocalHub.rows_push`, `HttpHub.rows_push`, `sync`)
- Modify: `tests/test_core.py`

**Interfaces:**
- Produces: `rows_push(table, columns, rows) -> dict` `{"upserted": int, "rejected": [{"id","col","rule","message"}]}` on both hubs. `sync()` returns `{"pushed","pulled","ddl_applied","rejected": [...]}`. `LocalHub` validates each pushed row against the catalog in its own db with `validate_row`, and verifies provenance for derived columns using `inputs_hash` computed over the pushed values.

- [ ] **Step 1: Write the failing tests**

```python
def test_hub_rejects_bad_row_but_accepts_rest(db, hub):
    from life_data.catalog import set_property

    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    insert_rows(db, "places", [{"id": "good", "status": "want"}])
    sync(db, hub)  # catalog reaches the hub first
    # a raw write that bypasses local validation
    c = sqlite3.connect(db)
    c.execute("INSERT INTO places (id, status) VALUES ('bad', 'Nope')")
    c.commit()
    c.close()
    stats = sync(db, hub)
    assert stats["rejected"][0]["id"] == "bad" and stats["rejected"][0]["rule"] == "options"
    assert {r["id"] for r in hub.rows_pull("places", ["id"], "")} == {"good"}
    assert sync(db, hub)["rejected"] == []  # cursor advanced; not re-pushed


def test_hub_rejects_derived_change_without_matching_provenance(db, hub):
    from life_data.catalog import derive, set_property

    create_table(db, "movies", ["title:text", "slug:text"])
    set_property(db, "movies", "slug", type="text", derived_by="sql:lower(title)", inputs=["title"])
    insert_rows(db, "movies", [{"id": "m1", "title": "A"}])
    derive(db, "movies", "slug")
    sync(db, hub)
    c = sqlite3.connect(db)
    c.execute("UPDATE movies SET slug = 'hand' WHERE id = 'm1'")
    c.commit()
    c.close()
    time.sleep(0.002)
    stats = sync(db, hub)
    assert stats["rejected"][0]["rule"] == "provenance"
    assert hub.rows_pull("movies", ["slug"], "")[0]["slug"] == "a"
```

- [ ] **Step 2: Run to verify they fail**

Run: `just test -- tests/test_core.py -q -k "hub_rejects"`
Expected: FAIL (`KeyError: 'rejected'`).

- [ ] **Step 3: Implement**

In `catalog.py`, a helper the hub-side uses (LocalHub now; the JS mirror in Task 8):

```python
def validate_push(conn, table: str, rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split pushed rows into (accepted, rejected). Property checks plus provenance
    for derived columns. Pure over the hub's own db."""
    props = [p for p in properties(conn, table)] if table not in ENGINE_TABLES else []
    accepted, rejected = [], []
    for row in rows:
        existing = (
            conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row["id"],)).fetchone()
            if _table_exists(conn, table)
            else None
        )
        before = dict(existing) if existing else None
        derived = {p["col"] for p in props if p.get("derived_by")}
        viol = validate_row(
            props,
            before,
            row,
            in_derive=derived,
            ref_ok=_ref_ok(conn),
            extra_options=_extra_options(conn),
        )
        for p in props:
            if not p.get("derived_by"):
                continue
            col = p["col"]
            changed = (
                (row.get(col) is not None)
                if before is None
                else not _same(row.get(col), before.get(col))
            )
            if not changed:
                continue
            prov = conn.execute(
                "SELECT inputs_hash, value_hash FROM provenance WHERE id = ? AND deleted_at IS NULL",
                (f"{table}:{row['id']}:{col}",),
            ).fetchone()
            casts = ", ".join("CAST(? AS TEXT)" for _ in (p.get("inputs") or [])) or "NULL"
            text = conn.execute(
                f"SELECT json_array({casts})", [row.get(c) for c in (p.get("inputs") or [])]
            ).fetchone()[0]
            vtext = conn.execute(
                "SELECT coalesce(CAST(? AS TEXT), '')", (row.get(col),)
            ).fetchone()[0]
            ok = (
                prov
                and prov["inputs_hash"] == hashlib.sha256(text.encode()).hexdigest()
                and prov["value_hash"] == hashlib.sha256(vtext.encode()).hexdigest()
            )
            if not ok:
                viol.append(
                    Violation(
                        table,
                        row["id"],
                        col,
                        "provenance",
                        f"{col} changed without a matching provenance record.",
                    )
                )
        if viol:
            rejected += [
                {
                    "id": row["id"],
                    **{k: v for k, v in x.as_dict().items() if k in ("col", "rule", "message")},
                }
                for x in viol
            ]
        else:
            accepted.append(row)
    return accepted, rejected
```

In `__init__.py`:

```python
class LocalHub:
    ...

    def rows_push(self, table, columns, rows) -> dict:
        with connect(self.path) as conn:
            accepted, rejected = catalog.validate_push(conn, table, rows)
        for i in range(0, len(accepted), CHUNK):
            self._query(_upsert_sql(table, columns), [json.dumps(accepted[i : i + CHUNK])])
        return {"upserted": len(accepted), "rejected": rejected}


class HttpHub:
    ...

    def rows_push(self, table, columns, rows) -> dict:
        total, rejected = 0, []
        for i in range(0, len(rows), CHUNK):
            out = self._post(
                "/v1/rows/push", {"table": table, "columns": columns, "rows": rows[i : i + CHUNK]}
            )
            total += out["upserted"]
            rejected += out.get("rejected", [])
        return {"upserted": total, "rejected": rejected}
```

In `sync()`: collect `rejected = []`; after `hub.rows_push(...)` do `rejected += [{"table": table, **r} for r in out["rejected"]]`; return it in the stats dict. In `main()` for `sync`, print the stats; if `rejected`, also print `{"rejected": [...]}` to stderr. Update the test server `_Handler` `/v1/rows/push` branch to return the dict from `h.rows_push(...)` directly (it already does, since it returns whatever `rows_push` returns; change `{"upserted": h.rows_push(...)}` to `h.rows_push(...)`). Update `test_second_sync_is_noop` to expect `"rejected": []`.

- [ ] **Step 4: Run tests, commit**

Run: `just test -q && just check`

```bash
git add src/life_data/__init__.py src/life_data/catalog.py tests/test_core.py
git commit -m "Hub validates pushed rows per row and reports rejections; sync surfaces them"
```

---

### Task 8: Worker validator, push route, catalog endpoint, bun tests

**Files:**
- Create: `worker/src/validate.js`
- Modify: `worker/src/index.js`
- Create: `worker/test/d1shim.js`, `worker/test/validate.test.js`, `worker/test/push.test.js`
- Modify: `worker/package.json`, `justfile`

**Interfaces:**
- Produces (JS): `validateRow(props, before, after, {inDerive, refOk, extraOptions})` returning `[{col, rule, message}]`, same order and rules as Python. `validatePush(db, table, rows)` async, returns `{accepted, rejected}`. `ROUTES["/v1/rows/push"]` returns `{upserted, rejected}`. `GET /v1/catalog` returns `{tables, properties, rules}` with `ETag`. Named exports: `validateRow`, `validatePush`, `ROUTES`, `allowed`.
- D1 shim: `new D1Shim(":memory:")` exposing `prepare(sql).bind(...).all()/first()/run()`.

- [ ] **Step 1: Write the conformance test and the shim**

```js
// worker/test/d1shim.js
import { Database } from "bun:sqlite";

export class D1Shim {
  constructor(path = ":memory:") {
    this.db = new Database(path);
  }
  prepare(sql) {
    const stmt = this.db.query(sql);
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async all() { return { results: stmt.all(...args) }; },
      async first() { return stmt.get(...args) ?? null; },
      async run() { stmt.run(...args); return {}; },
    };
  }
}
```

```js
// worker/test/validate.test.js
import { describe, expect, test } from "bun:test";
import cases from "../../tests/fixtures/validation-cases.json";
import { validateRow } from "../src/validate.js";

describe("validateRow conformance", () => {
  for (const c of cases) {
    test(c.name, () => {
      const refs = c.refs ?? {};
      const extra = c.extra_options ?? {};
      const got = validateRow(c.properties, c.before, c.after, {
        inDerive: new Set(c.in_derive ?? []),
        refOk: (t, id) => (refs[t] ?? []).includes(id),
        extraOptions: (p) => extra[p.col] ?? [],
      });
      expect(got.map((v) => ({ col: v.col, rule: v.rule }))).toEqual(c.expect);
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && bun test`
Expected: FAIL, cannot resolve `../src/validate.js`.

- [ ] **Step 3: Write the JS validator**

```js
// worker/src/validate.js
// Mirror of life_data.catalog.validate_row. The shared fixture in
// tests/fixtures/validation-cases.json is the contract; keep the two in step.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{5,}$/;

const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function asList(v) {
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v : null;
}

function same(a, b) {
  const la = asList(a), lb = asList(b);
  if (la && lb) return JSON.stringify(la) === JSON.stringify(lb);
  return a === b || (a == null && b == null);
}

function allowed(p, extraOptions) {
  const vals = (p.options ?? []).map((o) => o.v);
  if (p.options_sql && extraOptions) for (const x of extraOptions(p)) if (!vals.includes(x)) vals.push(x);
  return vals;
}

export function validateRow(props, before, after, { inDerive = new Set(), refOk = null, extraOptions = null } = {}) {
  const out = [];
  for (const p of props) {
    const col = p.col;
    const v = after[col];
    const was = before ? before[col] : null;
    const changed = before == null ? !empty(v) : !same(v, was);
    const label = p.label ?? col;
    const fail = (rule, message) => out.push({ col, rule, message });

    if (p.deprecated && !empty(v)) { fail("deprecated", `${col} is deprecated. Never write it.`); continue; }
    if (p.derived_by && changed && !inDerive.has(col)) { fail("derived", `${col} is derived by ${p.derived_by}. Run life derive.`); continue; }
    if (p.immutable && before != null && changed) { fail("immutable", `${col} is set once and never changed.`); continue; }
    if (p.required && empty(v)) { fail("required", `${label} is required.`); continue; }
    if (empty(v)) continue;

    const t = p.type ?? "text";
    if (t === "number" || t === "int") {
      const n = Number(v);
      if (typeof v === "boolean" || v === "" || Number.isNaN(n)) { fail("type", `${label} must be a number.`); continue; }
      if (t === "int" && !Number.isInteger(n)) { fail("type", `${label} must be an integer.`); continue; }
    } else if (t === "bool" && ![0, 1, true, false].includes(v)) { fail("type", `${label} must be 0 or 1.`); continue; }
    else if (t === "date" && !(typeof v === "string" && DATE_RE.test(v))) { fail("type", `${label} must be YYYY-MM-DD.`); continue; }
    else if (t === "datetime" && !(typeof v === "string" && DATETIME_RE.test(v))) { fail("type", `${label} must be ISO-8601 UTC with milliseconds.`); continue; }
    else if (t === "json") {
      try { typeof v === "string" ? JSON.parse(v) : JSON.stringify(v); } catch { fail("type", `${label} must be JSON.`); continue; }
    } else if (t === "url" && !(typeof v === "string" && /^https?:\/\//.test(v))) { fail("type", `${label} must be an http(s) URL.`); continue; }
    else if (t === "email" && !(typeof v === "string" && EMAIL_RE.test(v))) { fail("type", `${label} must be an email address.`); continue; }
    else if (t === "phone" && !(typeof v === "string" && PHONE_RE.test(v))) { fail("type", `${label} must be a phone number.`); continue; }
    else if (t === "select") {
      const a = allowed(p, extraOptions);
      if (a.length && !a.includes(v)) { fail("options", `${v} is not an option for ${col}. Allowed: ${a.join(", ")}`); continue; }
    } else if (t === "multi_select" || t === "multi_ref") {
      const items = asList(v);
      if (!items) { fail("type", `${label} must be a JSON array.`); continue; }
      if (t === "multi_select") {
        const a = allowed(p, extraOptions);
        const bad = items.filter((x) => a.length && !a.includes(x));
        if (bad.length) { fail("options", `Not options for ${col}: ${bad.join(", ")}. Allowed: ${a.join(", ")}`); continue; }
      }
      if (p.min_items && items.length < p.min_items) { fail("min_items", `${label} needs at least ${p.min_items}.`); continue; }
      if (p.max_items && items.length > p.max_items) { fail("max_items", `${label} allows at most ${p.max_items}.`); continue; }
      if (t === "multi_ref" && refOk && p.ref_table) {
        const missing = items.filter((x) => !refOk(p.ref_table, x));
        if (missing.length) { fail("ref", `No ${p.ref_table} row: ${missing.join(", ")}`); continue; }
      }
    } else if (t === "ref" && refOk && p.ref_table && !refOk(p.ref_table, v)) { fail("ref", `No ${p.ref_table} row with id ${v}.`); continue; }

    if (p.pattern && typeof v === "string" && !new RegExp(`^(?:${p.pattern})$`).test(v)) { fail("pattern", `${label} is not in the expected form.`); continue; }
  }
  return out;
}

const ENGINE_TABLES = new Set(["catalog_tables", "catalog_properties", "catalog_rules", "provenance", "catalog_log"]);

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tableExists(db, name) {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());
}

async function propertiesFor(db, table) {
  if (ENGINE_TABLES.has(table) || !(await tableExists(db, "catalog_properties"))) return [];
  const { results } = await db
    .prepare("SELECT * FROM catalog_properties WHERE deleted_at IS NULL AND tbl = ? ORDER BY sort, col")
    .bind(table).all();
  return (results ?? []).map((p) => ({
    ...p,
    options: p.options ? JSON.parse(p.options) : null,
    inputs: p.inputs ? JSON.parse(p.inputs) : [],
  }));
}

// Pre-resolve every lookup the pure validator needs (D1 is async), then validate.
export async function validatePush(db, table, rows) {
  const props = await propertiesFor(db, table);
  const exists = await tableExists(db, table);
  const derivedCols = new Set(props.filter((p) => p.derived_by).map((p) => p.col));

  const refSet = new Set();
  for (const p of props.filter((p) => (p.type === "ref" || p.type === "multi_ref") && p.ref_table)) {
    if (!(await tableExists(db, p.ref_table))) continue;
    const ids = new Set();
    for (const r of rows) for (const x of asList(r[p.col]) ?? [r[p.col]]) if (x != null) ids.add(x);
    for (const id of ids) {
      const hit = await db.prepare(`SELECT 1 FROM ${p.ref_table} WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
      if (hit) refSet.add(`${p.ref_table}:${id}`);
    }
  }
  const extra = {};
  for (const p of props.filter((p) => p.options_sql)) {
    const { results } = await db.prepare(p.options_sql).all();
    extra[p.col] = (results ?? []).map((r) => Object.values(r)[0]);
  }

  const accepted = [], rejected = [];
  for (const row of rows) {
    const before = exists ? await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(row.id).first() : null;
    const viol = validateRow(props, before, row, {
      inDerive: derivedCols,
      refOk: (t, id) => refSet.has(`${t}:${id}`),
      extraOptions: (p) => extra[p.col] ?? [],
    });
    for (const p of props.filter((p) => p.derived_by)) {
      const changed = before == null ? row[p.col] != null : !same(row[p.col], before[p.col]);
      if (!changed) continue;
      const prov = await db.prepare("SELECT inputs_hash, value_hash FROM provenance WHERE id = ? AND deleted_at IS NULL")
        .bind(`${table}:${row.id}:${p.col}`).first();
      const casts = p.inputs.map(() => "CAST(? AS TEXT)").join(", ") || "NULL";
      const text = Object.values(await db.prepare(`SELECT json_array(${casts}) AS j`).bind(...p.inputs.map((c) => row[c] ?? null)).first())[0];
      const vtext = Object.values(await db.prepare("SELECT coalesce(CAST(? AS TEXT), '') AS v").bind(row[p.col] ?? null).first())[0];
      const ok = prov && prov.inputs_hash === (await sha256hex(text)) && prov.value_hash === (await sha256hex(vtext));
      if (!ok) {
        viol.push({ col: p.col, rule: "provenance", message: `${p.col} changed without a matching provenance record.` });
      }
    }
    if (viol.length) rejected.push(...viol.map((v) => ({ id: row.id, ...v })));
    else accepted.push(row);
  }
  return { accepted, rejected };
}
```

- [ ] **Step 4: Wire the push route and the catalog endpoint**

In `worker/src/index.js`: `import { validatePush } from "./validate.js";` and replace the push route:

```js
  "/v1/rows/push": async (body, db) => {
    const rows = body.rows ?? [];
    const { accepted, rejected } = await validatePush(db, body.table, rows);
    if (accepted.length) {
      await db.prepare(upsertSql(body.table, body.columns)).bind(JSON.stringify(accepted)).run();
    }
    return { upserted: accepted.length, rejected };
  },
```

Add the catalog route to `allowed()`'s readOnly list (`pathname === "/v1/catalog"`) and in `fetch()` before the ROUTES check:

```js
      if (url.pathname === "/v1/catalog" && request.method === "GET") {
        await ensureReady(tenant.db);
        const out = {};
        for (const t of ["catalog_tables", "catalog_properties", "catalog_rules"]) {
          const exists = await tenant.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
          const { results } = exists ? await tenant.db.prepare(`SELECT * FROM ${t} WHERE deleted_at IS NULL ORDER BY id`).all() : { results: [] };
          out[t.replace("catalog_", "")] = results ?? [];
        }
        const text = JSON.stringify(out);
        const etag = `"${(await sha256hex(text)).slice(0, 32)}"`;
        if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
        return new Response(text, { headers: { "Content-Type": "application/json", ETag: etag } });
      }
```

Export for tests: `export { ROUTES, allowed, validatePush };` at the bottom of `index.js` (keep `export default`).

- [ ] **Step 5: Write the push test**

```js
// worker/test/push.test.js
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, derived_by TEXT, inputs_hash TEXT, value_hash TEXT, source_ref TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE places (id TEXT PRIMARY KEY, status TEXT, slug TEXT, name TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, type, options) VALUES ('places.status','places','status','select','[{"v":"want"}]')`,
    `INSERT INTO catalog_properties (id, tbl, col, type, derived_by, inputs) VALUES ('places.slug','places','slug','text','sql:lower(name)','["name"]')`,
  ]) await db.prepare(sql).run();
}

const cols = ["id", "status", "slug", "name", "updated_at"];
const row = (o) => ({ id: "a", status: "want", slug: null, name: "A", updated_at: "2026-09-03T00:00:00.000Z", ...o });

test("rejects the bad row, accepts the good one, never fails the batch", async () => {
  const db = new D1Shim();
  await seed(db);
  const out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ id: "good" }), row({ id: "bad", status: "Nope" })] }, db);
  expect(out.upserted).toBe(1);
  expect(out.rejected[0]).toMatchObject({ id: "bad", col: "status", rule: "options" });
  const { results } = await db.prepare("SELECT id FROM places").all();
  expect(results.map((r) => r.id)).toEqual(["good"]);
});

test("derived column needs matching provenance", async () => {
  const db = new D1Shim();
  await seed(db);
  let out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ slug: "a" })] }, db);
  expect(out.rejected[0].rule).toBe("provenance");
  // provenance for name='A' -> slug 'a': inputs_hash = sha256(json_array('A')), value_hash = sha256('a')
  const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash) VALUES ('places:a:slug','places','a','slug','sql:lower(name)',?,?)").bind(await hex('["A"]'), await hex("a")).run();
  out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ slug: "a" })] }, db);
  expect(out.rejected).toEqual([]);
  expect(out.upserted).toBe(1);
  // a hand edit to the value with unchanged inputs is still caught
  out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ slug: "hand", updated_at: "2026-09-04T00:00:00.000Z" })] }, db);
  expect(out.rejected[0].rule).toBe("provenance");
});
```

- [ ] **Step 6: Wire bun test into the repo**

`worker/package.json` scripts: add `"test": "bun test"`. `justfile`:

```
test:
    uv run pytest
    cd worker && bun test
```

- [ ] **Step 7: Run everything**

Run: `just test && just check`
Expected: pytest green, bun test green (all fixture cases + 2 push tests).

- [ ] **Step 8: Commit**

```bash
git add worker/src/validate.js worker/src/index.js worker/test worker/package.json justfile
git commit -m "Hub: per-row validation with provenance, GET /v1/catalog, bun tests over a D1 shim"
```

---

### Task 9: `life audit`

**Files:**
- Modify: `src/life_data/catalog.py`, `src/life_data/__init__.py`, `tests/test_catalog.py`

**Interfaces:**
- Produces: `audit(path, rule_id=None, commands=None) -> list[dict]`. An audit rule's `cmd` names a key in config `commands`; the command receives `{"rule": id, "tbl": tbl}` on stdin and prints a JSON array of `{tbl, row_id, col, message}`; each is returned with `rule` set to the rule id. Never modifies data.

- [ ] **Step 1: Failing test**

```python
from life_data.catalog import audit


def test_audit_runs_command_and_reports_findings(db, tmp_path):
    script = tmp_path / "check_tmdb.py"
    script.write_text(
        "import json\nprint(json.dumps([{'tbl':'movies','row_id':'m1','col':'title','message':'not TMDB-exact'}]))\n"
    )
    set_rule(
        db,
        "tmdb-exact",
        scope="table",
        tbl="movies",
        kind="audit",
        cmd="tmdb-exact",
        text="Titles must be TMDB-exact",
    )
    findings = audit(db, commands={"tmdb-exact": f"python3 {script}"})
    assert findings == [
        {
            "tbl": "movies",
            "row_id": "m1",
            "col": "title",
            "rule": "tmdb-exact",
            "message": "not TMDB-exact",
        }
    ]
```

- [ ] **Step 2: Run to verify it fails**: `just test -- -q -k audit` → ImportError.

- [ ] **Step 3: Implement**

```python
# --- audit -------------------------------------------------------------------


def audit(path: Path, rule_id: str | None = None, commands: dict | None = None) -> list[dict]:
    out = []
    with _pkg().connect(path) as conn:
        todo = [r for r in rules(conn, kind="audit") if not rule_id or r["id"] == rule_id]
    for r in todo:
        cmd = (commands or {}).get(r.get("cmd") or "")
        if not cmd:
            raise RuntimeError(
                f"no command configured for audit {r['id']!r} (config.json: commands)"
            )
        res = subprocess.run(
            cmd,
            shell=True,
            input=json.dumps({"rule": r["id"], "tbl": r.get("tbl")}),
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode != 0:
            raise RuntimeError(f"audit {r['id']} failed: {res.stderr.strip()[:500]}")
        for f in json.loads(res.stdout or "[]"):
            out.append(
                {
                    "tbl": f.get("tbl", r.get("tbl")),
                    "row_id": f.get("row_id"),
                    "col": f.get("col"),
                    "rule": r["id"],
                    "message": f.get("message", r["text"]),
                }
            )
    return out
```

CLI: `life audit [id]` prints JSON, exit 1 if findings.

- [ ] **Step 4: Run, commit**: `just test -q && just check`; `git commit -m "Add life audit"`.

---

### Task 10: `life infer`

**Files:**
- Modify: `src/life_data/catalog.py`, `src/life_data/__init__.py`, `tests/test_catalog.py`

**Interfaces:**
- Produces: `infer(path, tbl=None, min_rows=20) -> list[dict]`, each a proposed `catalog_properties` row (`tbl, col, type, required?, options?, pattern?, ref_table?`) for columns not yet cataloged. `life infer [tbl] [--apply]` prints proposals; `--apply` writes them via `set_property`.

- [ ] **Step 1: Failing test**

```python
from life_data.catalog import infer


def test_infer_proposes_required_select_date_url_ref(db):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": f"p{i}", "name": f"n{i}"} for i in range(25)])
    create_table(
        db, "places", ["name:text", "status:text", "went:text", "url:text", "who:text", "tags:text"]
    )
    insert_rows(
        db,
        "places",
        [
            {
                "name": f"x{i}",
                "status": ("want", "been")[i % 2],
                "went": f"2026-01-{i + 1:02d}",
                "url": f"https://maps.app.goo.gl/{i}",
                "who": f"p{i}",
                "tags": ["bar"] if i % 3 else ["cafe"],
            }
            for i in range(25)
        ],
    )
    props = {p["col"]: p for p in infer(db, "places")}
    assert props["name"]["required"] == 1 and props["name"]["type"] == "text"
    assert props["status"]["type"] == "select" and {o["v"] for o in props["status"]["options"]} == {
        "want",
        "been",
    }
    assert props["went"]["type"] == "date"
    assert props["url"]["type"] == "url" and props["url"]["pattern"].startswith("^https://")
    assert props["who"] == {
        "tbl": "places",
        "col": "who",
        "type": "ref",
        "ref_table": "people",
        "required": 1,
    }
    assert props["tags"]["type"] == "multi_select" and {
        o["v"] for o in props["tags"]["options"]
    } == {"bar", "cafe"}


def test_infer_skips_cataloged_columns_and_small_tables(db):
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"name": "a"}])
    assert infer(db, "places") == []
```

- [ ] **Step 2: Run to verify it fails**: ImportError.

- [ ] **Step 3: Implement**

```python
# --- infer -------------------------------------------------------------------

SYNC_COLS = {"id", "created_at", "updated_at", "deleted_at"}


def infer(path: Path, tbl: str | None = None, min_rows: int = 20) -> list[dict]:
    pkg = _pkg()
    out = []
    with pkg.connect(path) as conn:
        tables = (
            [tbl]
            if tbl
            else [
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
                if not r[0].startswith(("_", "sqlite_")) and r[0] not in ENGINE_TABLES
            ]
        )
        id_sets = {}
        for t in tables:
            n = conn.execute(f"SELECT count(*) FROM {t} WHERE deleted_at IS NULL").fetchone()[0]
            if n < min_rows:
                continue
            known = {p["col"] for p in properties(conn, t)}
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({t})").fetchall()]
            for c in cols:
                if c in SYNC_COLS or c in known:
                    continue
                vals = [
                    r[0]
                    for r in conn.execute(
                        f"SELECT {c} FROM {t} WHERE deleted_at IS NULL AND {c} IS NOT NULL AND {c} != ''"
                    ).fetchall()
                ]
                prop = {"tbl": t, "col": c, "type": "text"}
                if len(vals) == n:
                    prop["required"] = 1
                if not vals:
                    out.append(prop)
                    continue
                strs = [v for v in vals if isinstance(v, str)]
                lists = [_as_list(v) for v in strs]
                if strs and all(l is not None for l in lists):
                    flat = sorted({x for l in lists for x in l})
                    if len(flat) <= 30:
                        prop.update(type="multi_select", options=[{"v": x} for x in flat])
                        out.append(prop)
                        continue
                if strs and all(DATE_RE.match(v) for v in strs):
                    prop["type"] = "date"
                elif strs and all(v.startswith(("http://", "https://")) for v in strs):
                    prop.update(
                        type="url",
                        pattern="^https://.+"
                        if all(v.startswith("https://") for v in strs)
                        else "^https?://.+",
                    )
                else:
                    ref = _ref_target(conn, tables, vals, id_sets, exclude=t)
                    if ref:
                        prop.update(type="ref", ref_table=ref)
                    else:
                        distinct = sorted(set(map(str, vals)))
                        if len(distinct) <= 20 and len(distinct) / len(vals) < 0.5:
                            prop.update(type="select", options=[{"v": v} for v in distinct])
                out.append(prop)
    return out


def _ref_target(conn, tables, vals, id_sets, exclude):
    for t in tables:
        if t == exclude:
            continue
        if t not in id_sets:
            id_sets[t] = {r[0] for r in conn.execute(f"SELECT id FROM {t}").fetchall()}
        if id_sets[t] and all(v in id_sets[t] for v in vals):
            return t
    return None
```

CLI: `life infer [table] [--apply] [--min-rows N]`; prints proposals as JSON; with `--apply`, calls `set_property(path, p["tbl"], p["col"], **rest)` for each and prints the count.

- [ ] **Step 4: Run, commit**: `just test -q && just check`; `git commit -m "Add life infer"`.

---

### Task 11: `life doc`

**Files:**
- Modify: `src/life_data/catalog.py`, `src/life_data/__init__.py`, `tests/test_catalog.py`

**Interfaces:**
- Produces: `doc(conn, tbl=None) -> str` deterministic markdown: for each `catalog_tables` row (or every cataloged table without one), a `### <tbl>` section with purpose, id semantics, provenance, owner, consumers; a properties table (`col | type | required | constraint | description`) where constraint renders options/pattern/ref/derived/immutable/deprecated; then rules for the table (kind, id, text, sql in a fence for invariants). Estate-scoped rules render under `## Estate rules`.

- [ ] **Step 1: Failing test**

```python
from life_data.catalog import doc


def test_doc_renders_tables_properties_and_rules(db):
    set_table(db, "places", kind="table", purpose="somewhere real", id_semantics="Google place_id")
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        sort=1,
        options=[{"v": "want", "d": "saved"}, {"v": "been"}],
        description="lowercase",
    )
    set_property(
        db, "places", "slug", type="text", sort=2, derived_by="sql:lower(name)", inputs=["name"]
    )
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    with connect(db) as conn:
        md = doc(conn)
    assert "### places" in md and "somewhere real" in md and "Google place_id" in md
    assert "| status | select | yes | `want` (saved), `been` | lowercase |" in md
    assert "derived by `sql:lower(name)` from name" in md
    assert "## Estate rules" in md and "soft delete only" in md
    with connect(db) as conn:
        assert doc(conn) == md  # deterministic
```

- [ ] **Step 2: Run to verify it fails**: ImportError.

- [ ] **Step 3: Implement**

```python
# --- doc ---------------------------------------------------------------------


def _constraint(p: dict) -> str:
    parts = []
    if p.get("options"):
        parts.append(
            ", ".join(f"`{o['v']}`" + (f" ({o['d']})" if o.get("d") else "") for o in p["options"])
        )
    if p.get("options_sql"):
        parts.append(f"plus `{p['options_sql']}`")
    if p.get("min_items") or p.get("max_items"):
        parts.append(f"{p.get('min_items') or 0}..{p.get('max_items') or '∞'} items")
    if p.get("pattern"):
        parts.append(f"matches `{p['pattern']}`")
    if p.get("ref_table"):
        parts.append(f"→ {p['ref_table']}")
    if p.get("derived_by"):
        parts.append(f"derived by `{p['derived_by']}` from {', '.join(p.get('inputs') or [])}")
    if p.get("default_value") is not None:
        parts.append(f"default `{p['default_value']}`")
    if p.get("immutable"):
        parts.append("immutable")
    if p.get("deprecated"):
        parts.append("**deprecated**")
    return "; ".join(parts)


def doc(conn: sqlite3.Connection, tbl: str | None = None) -> str:
    lines = ["# Estate map", "", "_Generated by `life doc`. Do not edit by hand._", ""]
    described = (
        {
            r["id"]: dict(r)
            for r in conn.execute(
                "SELECT * FROM catalog_tables WHERE deleted_at IS NULL ORDER BY id"
            ).fetchall()
        }
        if has_catalog(conn)
        else {}
    )
    names = sorted(set(described) | set(cataloged_tables(conn)))
    for t in names:
        if tbl and t != tbl:
            continue
        meta = described.get(t, {})
        lines += [f"### {t}", ""]
        if meta.get("purpose"):
            lines += [meta["purpose"], ""]
        for k, label in (
            ("id_semantics", "Row id"),
            ("provenance", "From"),
            ("owner", "Written by"),
        ):
            if meta.get(k):
                lines.append(f"- **{label}:** {meta[k]}")
        if meta.get("consumers"):
            lines.append(f"- **Read by:** {', '.join(json.loads(meta['consumers']))}")
        if meta.get("description"):
            lines += ["", meta["description"]]
        props = properties(conn, t)
        if props:
            lines += [
                "",
                "| col | type | required | constraint | description |",
                "|---|---|---|---|---|",
            ]
            for p in props:
                lines.append(
                    f"| {p['col']} | {p.get('type', 'text')} | {'yes' if p.get('required') else ''} | "
                    f"{_constraint(p)} | {p.get('description') or ''} |"
                )
        trules = [r for r in rules(conn, tbl=t) if r.get("tbl") == t]
        if trules:
            lines += ["", "**Rules**", ""]
            for r in trules:
                flag = " (enforced)" if r.get("enforce") else ""
                lines.append(f"- `{r['kind']}` **{r['id']}**{flag}: {r['text']}")
                if r.get("sql"):
                    lines += ["", "  ```sql", f"  {r['sql']}", "  ```", ""]
        lines.append("")
    estate = [r for r in rules(conn) if r.get("scope") == "estate"]
    if estate and not tbl:
        lines += ["## Estate rules", ""]
        for r in estate:
            lines.append(f"- `{r['kind']}` **{r['id']}**: {r['text']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
```

CLI: `life doc [table]` prints it.

- [ ] **Step 4: Run, commit**: `just test -q && just check`; `git commit -m "Add life doc"`.

---

### Task 12: `life table create` typed syntax, docs, and the skill

**Files:**
- Modify: `src/life_data/__init__.py:88-104` (`create_table`)
- Modify: `tests/test_core.py`
- Modify: `AGENTS.md`
- Modify: `~/.claude/skills/life-cli/SKILL.md` (outside the repo; generic mechanics only)

**Interfaces:**
- `create_table(path, name, columns)` accepts `col:type[!][(a|b|c)]`: `type` may be a catalog type (mapped to storage via `STORAGE`) or a raw SQLite type; `!` marks required; `(a|b|c)` sets options for `select`/`multi_select`. Every column gets a `catalog_properties` row (plain `text` columns included, so every table is documented from birth).

- [ ] **Step 1: Failing test** (in `tests/test_core.py`)

```python
def test_create_table_typed_syntax_writes_catalog_rows(db):
    from life_data.catalog import properties

    create_table(
        db,
        "places",
        ["name:text!", "status:select!(want|been)", "tags:multi_select(bar|cafe)", "lat:number"],
    )
    cols = {r["name"]: r["type"] for r in execute_sql(db, "PRAGMA table_info(places)")}
    assert cols["status"] == "TEXT" and cols["lat"] == "REAL"
    with connect(db) as conn:
        p = {x["col"]: x for x in properties(conn, "places")}
    assert p["name"]["required"] == 1
    assert p["status"]["options"] == [{"v": "want"}, {"v": "been"}]
    assert p["tags"]["type"] == "multi_select"
    with pytest.raises(catalog.ValidationError):
        insert_rows(db, "places", [{"name": "x", "status": "Been"}])
```

(Import `catalog` at the top of the test file: `from life_data import catalog`.)

- [ ] **Step 2: Run to verify it fails**: `just test -- -q -k typed_syntax` → FAIL (SQL syntax error on `select!(want|been)`).

- [ ] **Step 3: Implement**

```python
COLSPEC = re.compile(r"^(?P<col>\w+):(?P<type>\w+)(?P<req>!)?(?:\((?P<opts>[^)]*)\))?$")


def create_table(path: Path, name: str, columns: list[str]) -> None:
    specs = []
    for c in columns:
        m = COLSPEC.match(c)
        if not m:
            raise ValueError(f"bad column spec {c!r}; expected col:type[!][(a|b)]")
        specs.append(m.groupdict())
    user_cols = ",\n    ".join(
        f"{s['col']} {catalog.STORAGE.get(s['type'].lower(), s['type'].upper())}" for s in specs
    )
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
    if name in catalog.ENGINE_TABLES:
        return
    for i, s in enumerate(specs):
        t = s["type"].lower()
        fields = {"type": t if t in catalog.TYPES else "text", "sort": (i + 1) * 10}
        if s["req"]:
            fields["required"] = 1
        if s["opts"] is not None:
            fields["options"] = [{"v": o.strip()} for o in s["opts"].split("|") if o.strip()]
        catalog.set_property(path, name, s["col"], **fields)
```

Add `import re` to `__init__.py`.

- [ ] **Step 4: Update AGENTS.md**

In `## Layout`, add `src/life_data/catalog.py — the catalog engine: typed properties, rules, derivations, provenance, check/audit/infer/doc. Pure over a sqlite3 connection.` and `worker/src/validate.js — the hub-side mirror of the row validator; tests/fixtures/validation-cases.json is the contract both run.` and `worker/test/ — bun test over a bun:sqlite D1 shim.`

In `## Conventions`, add:

```
- **Writes are validated.** `execute_sql` and `insert_rows` run inside
  `catalog.write()`: one transaction, every changed row in a cataloged table
  checked, `ValidationError` after ROLLBACK. Reads (SELECT/PRAGMA/EXPLAIN/
  WITH) bypass it. Sync's pull upsert bypasses it on purpose (pulled rows were
  validated where they were written). The hub validates pushed rows per row
  and never fails a batch.
- **Checks are pure; producers may touch the world.** Invariant SQL is one
  SELECT with no `random()`, `localtime`, or `'now'` (use `(SELECT ts FROM
  now)`; `changed`/`before` are temp tables the engine provides). Derivations
  (`derived_by: sql:|cmd:`) and audits run only via `life derive` /
  `life audit` and record `provenance`. A derived column rejects direct
  writes everywhere; the hub verifies `provenance.inputs_hash` against the
  pushed inputs and never runs the command.
- `catalog_*` and `provenance` sync before every other table.
- `just test` runs pytest AND `bun test` in `worker/`.
```

- [ ] **Step 5: Update the life-cli skill** (generic; no personal values)

Add a `## Catalog (typed properties, rules, derivations)` section documenting: `life table create places name:text! status:select!(want|been) tags:multi_select(bar|cafe)`, `life property set/list/rm`, `life rule set/list/rm`, `life table set`, `life derive`, `life check`, `life audit`, `life infer [--apply]`, `life doc`, the `commands` map in `config.json` for `cmd:` derivations and audits, the command protocols (stdin JSON in, JSON out), and that a `ValidationError` prints `{"rejected": [...]}` on stderr with exit 1. Replace the "SQLite enforces NOTHING" warning with "SQLite enforces nothing; the catalog does. An uncataloged column is unconstrained."

- [ ] **Step 6: Run everything, commit**

Run: `just test && just check`

```bash
git add src/life_data/__init__.py tests/test_core.py AGENTS.md
git commit -m "Typed table create writes catalog rows; document the catalog engine"
```

Then in the agent-config-public clone (the skill's real location):

```bash
git add skills/life-cli/SKILL.md
git commit -m "life-cli: document the catalog commands"
```

---

## Self-review

**Spec coverage.** Schemas → Task 1. Type system → Tasks 2, 12. Validation order (req. 3–12) → Tasks 2, 3. `changed`/`before`/`now`, compile, forbidden tokens (req. 13–18) → Task 4. Hub per-row rejection, provenance, catalog endpoint (req. 19–23) → Tasks 7, 8. `check` incl. staleness/underived (req. 24) → Tasks 5, 6. `audit` (25) → Task 9. `infer` (26) → Task 10. `doc` (27) → Task 11. No model/command/network on the write path (28) → by construction; `_run_command` is only reachable from `derive` and `audit`. Threat model's `life watch` drift check → Task 5. Catalog edit log → Task 1 (`catalog_log`). Command-derived columns never `required` → enforced in `set_property` (Task 6).

**Deviations from the spec, recorded:** (1) `:now` is a one-row temp table `now(ts)` rather than a bound parameter, for D1 portability. (2) The hub runs property checks and provenance verification, not SQL invariants. (3) The write-path `before` snapshot is a whole-table temp copy, not only immutable/derived columns, because `before` for invariants needs full rows. The spec has been updated to match.

**Type consistency.** `validate_row` signature identical in Tasks 2, 3, 5, 7. `rows_push` returns a dict on both hubs and the test server after Task 7 (`test_second_sync_is_noop` updated). `Violation.as_dict()` keys are what `check`, `audit`, and the CLI print. `derived_by` prefixes `sql:`/`cmd:` used identically in `set_property`, `derive`, `compile_all`, `validate.js`.
