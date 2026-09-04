"""Catalog engine: typed properties, rules, derivations, provenance.

Pure over a sqlite3 connection. No CLI, no network. The CLI in __init__ calls
into this; nothing here knows about hubs or argv.
"""

import json
import re
import sqlite3
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
            sets = ", ".join([*(f"{k} = ?" for k in enc), "deleted_at = NULL"])
            conn.execute(
                f"UPDATE {table} SET {sets} WHERE id = ?",
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
    d = fields.get("derived_by") or ""
    if d.startswith("sql:"):
        with _pkg().connect(path) as conn:
            if _table_exists(conn, tbl):
                try:
                    conn.execute(f"SELECT ({d[4:]}) FROM {tbl} LIMIT 0")
                except sqlite3.Error as e:
                    raise ValueError(f"derivation does not compile: {e}") from e
    return _upsert(path, "catalog_properties", f"{tbl}.{col}", {"tbl": tbl, "col": col, **fields})


def rm_property(path: Path, tbl: str, col: str) -> None:
    _soft_delete(path, "catalog_properties", f"{tbl}.{col}")


def set_rule(path: Path, rule_id: str, **fields) -> dict:
    if "kind" in fields and fields["kind"] not in RULE_KINDS:
        raise ValueError(f"unknown kind {fields['kind']!r}; one of {sorted(RULE_KINDS)}")
    if fields.get("sql"):
        check_rule_sql(fields["sql"])
        with _pkg().connect(path) as conn:
            compile_sql(conn, fields["sql"], fields.get("tbl"))
    return _upsert(path, "catalog_rules", rule_id, fields)


def rm_rule(path: Path, rule_id: str) -> None:
    _soft_delete(path, "catalog_rules", rule_id)


def set_table(path: Path, table_id: str, **fields) -> dict:
    return _upsert(path, "catalog_tables", table_id, fields)


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

        if p.get("pattern") and isinstance(v, str) and not re.fullmatch(p["pattern"], v):
            fail(col, "pattern", f"{label} is not in the expected form.")
            continue

        if t == "ref" and ref_ok and p.get("ref_table") and not ref_ok(p["ref_table"], v):
            fail(col, "ref", f"No {p['ref_table']} row with id {v}.")
            continue
        if t == "multi_ref" and ref_ok and p.get("ref_table"):
            missing = [x for x in _as_list(v) if not ref_ok(p["ref_table"], x)]
            if missing:
                fail(col, "ref", f"No {p['ref_table']} row: {', '.join(map(str, missing))}")
                continue
    return out


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


def write(path: Path, fn, *, in_derive=(), ddl: bool = False):
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
            if ddl:
                for rid in compile_all(conn):
                    violations.append(
                        Violation(
                            "catalog",
                            rid,
                            None,
                            "compile",
                            f"{rid} no longer compiles after this DDL.",
                        )
                    )
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
        changed_ids = [r["id"] for r in rows]
        for rule in rules(conn, tbl=t, kind="invariant"):
            if not rule.get("enforce") or rule.get("tbl") != t:
                continue
            hits = run_invariant(conn, rule, changed_ids=changed_ids, now=t0)
            for h in hits:
                out.append(Violation(t, h.get("id"), rule.get("col"), rule["id"], rule["text"]))
    return out


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
    # ponytail: catalog tables come up one CREATE TABLE at a time during
    # ensure_catalog's own bootstrap DDL, so a sibling catalog table (e.g.
    # catalog_rules) may not exist yet even though catalog_properties does.
    if _table_exists(conn, "catalog_rules"):
        for r in rules(conn, kind="invariant"):
            try:
                compile_sql(conn, r["sql"], r.get("tbl"))
            except ValueError:
                bad.append(r["id"])
    if _table_exists(conn, "catalog_properties"):
        for p in properties(conn):
            d = p.get("derived_by") or ""
            if d.startswith("sql:") and _table_exists(conn, p["tbl"]):
                try:
                    conn.execute(f"SELECT ({d[4:]}) FROM {p['tbl']} LIMIT 0")
                except sqlite3.Error:
                    bad.append(p["id"])
    return bad
