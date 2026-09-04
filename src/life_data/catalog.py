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
    if fields.get("required") and str(fields.get("derived_by") or "").startswith("cmd:"):
        raise ValueError(
            "a cmd-derived column cannot be required: the row is valid but incomplete until derived"
        )
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
    if fields.get("kind") == "invariant" and not fields.get("sql"):
        raise ValueError("an invariant needs sql: the SELECT whose rows are the violations")
    if fields.get("scope") == "estate" and fields.get("enforce"):
        raise ValueError(
            "an estate-scoped rule cannot be enforced: only life check runs it. "
            "Write a per-table rule to enforce on the write path."
        )
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


def _validated_tables(conn: sqlite3.Connection) -> list[str]:
    """Tables the write path checks: those with catalog properties, plus any
    table an invariant names (a rule on a raw `life sql` table still runs)."""
    named = set(cataloged_tables(conn))
    if _table_exists(conn, "catalog_rules"):
        named |= {r["tbl"] for r in rules(conn, kind="invariant") if r.get("tbl")}
    return sorted(named - ENGINE_TABLES)


def write(path: Path, fn, *, in_derive=(), ddl: bool = False):
    """Run fn(conn) in one transaction; validate every changed row in every
    cataloged table; ROLLBACK and raise ValidationError on any violation."""
    pkg = _pkg()
    conn = pkg.connect(path, manual_tx=True)
    try:
        tables = [t for t in _validated_tables(conn) if _table_exists(conn, t)]
        conn.execute("BEGIN")
        t0 = conn.execute(f"SELECT {pkg.NOW}").fetchone()[0]
        marks = {}
        for t in tables:
            # ponytail: whole-table snapshot per write; scope by rowid past ~1M rows
            conn.execute(
                f"CREATE TEMP TABLE temp._before_{t} AS SELECT rowid AS _rowid, * FROM {t}"
            )
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
            b = conn.execute(
                f"SELECT * FROM temp._before_{t} WHERE id = ?", (after["id"],)
            ).fetchone()
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
    # every temp DDL/DML below is schema-qualified `temp.`: unqualified names
    # resolve temp-first but fall through to main, so an unqualified DROP would
    # destroy a USER table named `now`/`changed`/`before` on the first run
    if _uses(sql, "now"):
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS temp.now (ts TEXT)")
        conn.execute("DELETE FROM temp.now")
        conn.execute(
            "INSERT INTO temp.now (ts) VALUES (?)",
            (now or conn.execute(f"SELECT {_pkg().NOW}").fetchone()[0],),
        )
        made.append("now")
    if tbl and (_uses(sql, "changed") or _uses(sql, "before")):
        ids = list(changed_ids or [])
        ph = ", ".join("?" for _ in ids) or "NULL"
        conn.execute("DROP TABLE IF EXISTS temp.changed")
        conn.execute(
            f"CREATE TEMP TABLE temp.changed AS SELECT * FROM {tbl} WHERE id IN ({ph})", ids
        )
        conn.execute("DROP TABLE IF EXISTS temp.before")
        if _table_exists_temp(conn, f"_before_{tbl}"):
            # explicit column list, not `*`: _before_{tbl} carries an extra
            # _rowid bookkeeping column that would break shape-sensitive
            # queries (EXCEPT/UNION) against `changed`, which has tbl's shape
            cols = ", ".join(r[1] for r in conn.execute(f"PRAGMA table_info({tbl})").fetchall())
            conn.execute(
                f"CREATE TEMP TABLE temp.before AS SELECT {cols} "
                f"FROM temp._before_{tbl} WHERE id IN ({ph})",
                ids,
            )
        else:
            conn.execute(f"CREATE TEMP TABLE temp.before AS SELECT * FROM {tbl} WHERE 0")
        made += ["changed", "before"]

    def cleanup():
        for t in made:
            conn.execute(f"DROP TABLE IF EXISTS temp.{t}")

    return cleanup


def _table_exists_temp(conn, name) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_temp_master WHERE name = ?", (name,)).fetchone()
        is not None
    )


def compile_sql(conn: sqlite3.Connection, sql: str, tbl: str | None = None) -> None:
    def cleanup():
        pass

    try:
        cleanup = _with_context(conn, sql, [], None, tbl)
        conn.execute(f"SELECT * FROM ({sql}) LIMIT 0")
    except sqlite3.Error as e:
        raise ValueError(f"sql does not compile: {e}") from e
    finally:
        cleanup()


def run_invariant(conn, rule: dict, changed_ids=None, now=None) -> list[dict]:
    def cleanup():
        pass

    try:
        cleanup = _with_context(conn, rule["sql"], changed_ids, now, rule.get("tbl"))
        return [dict(r) for r in conn.execute(rule["sql"]).fetchall()]
    finally:
        cleanup()


# --- derivations & provenance -------------------------------------------------


def inputs_hash(conn, tbl: str, row_id: str, inputs: list[str]) -> str | None:
    """Hash the inputs as SQLite renders them, so Python and the hub agree byte
    for byte. None when the row is gone (hard-deleted out from under its
    provenance)."""
    casts = ", ".join(f"CAST({c} AS TEXT)" for c in inputs) or "NULL"
    row = conn.execute(f"SELECT json_array({casts}) FROM {tbl} WHERE id = ?", (row_id,)).fetchone()
    return hashlib.sha256(row[0].encode()).hexdigest() if row else None


def value_hash(conn, tbl: str, row_id: str, col: str) -> str | None:
    row = conn.execute(
        f"SELECT coalesce(CAST({col} AS TEXT), '') FROM {tbl} WHERE id = ?", (row_id,)
    ).fetchone()
    return hashlib.sha256(row[0].encode()).hexdigest() if row else None


def _run_command(cmd: str, payload: dict) -> dict:
    out = subprocess.run(
        cmd, shell=True, input=json.dumps(payload), capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise RuntimeError(f"derivation command failed: {out.stderr.strip()[:500]}")
    result = json.loads(out.stdout or "{}")
    if not isinstance(result, dict):
        raise TypeError("derivation command must print a JSON object")
    return result


def derive(
    path: Path, tbl: str, col: str, where: str | None = None, commands: dict | None = None
) -> int:
    """Run one `sql:` or `cmd:` derivation for tbl's rows in a single write():
    one transaction, all-or-nothing, with a provenance row per written cell."""
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
            # a row can vanish (hard or soft delete) between the read-only id
            # listing above and this transaction; skip it rather than crash
            row = conn.execute(f"SELECT * FROM {tbl} WHERE id = ?", (rid,)).fetchone()
            if row is None or row["deleted_at"] is not None:
                continue
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
                result = _run_command(
                    cmd, {"tbl": tbl, "id": rid, "inputs": {c: row[c] for c in inputs}}
                )
                source_ref = result.pop("_source_ref", None)
                values = {k: v for k, v in result.items() if k in cols}
            if not values:  # a cmd: derivation returned no known columns for this row
                continue
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
            h = inputs_hash(conn, p["tbl"], r["row_id"], p.get("inputs") or [])
            if h is None:
                out.append(
                    Violation(
                        p["tbl"],
                        r["row_id"],
                        p["col"],
                        "orphan",
                        "provenance exists for a row that no longer exists",
                    )
                )
            elif h != r["inputs_hash"]:
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


# --- check -------------------------------------------------------------------


def check(path: Path, as_of: str | None = None) -> list[dict]:
    """Whole-estate, read-only report: every property violation (whole-table
    state, not just changed rows) and every invariant regardless of enforce."""
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
            try:
                hits = run_invariant(conn, rule, changed_ids=[], now=as_of)
            except (sqlite3.Error, ValueError, TypeError) as e:
                out.append(
                    Violation(
                        rule.get("tbl") or "estate",
                        None,
                        rule.get("col"),
                        "rule-error",
                        f"{rule['id']} failed to run: {e}",
                    )
                )
                continue
            for h in hits:
                out.append(
                    Violation(
                        rule.get("tbl") or "estate",
                        h.get("id"),
                        rule.get("col"),
                        rule["id"],
                        rule["text"],
                    )
                )
        out += stale(conn) + underived(conn)
    return [v.as_dict() for v in out]


def validate_push(
    conn: sqlite3.Connection, table: str, rows: list[dict]
) -> tuple[list[dict], list[dict]]:
    """Split pushed rows into (accepted, rejected). Property checks plus provenance
    for derived columns. Pure over the hub's own db; never runs a derivation."""
    props = properties(conn, table) if table not in ENGINE_TABLES else []
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


# --- infer -------------------------------------------------------------------

SYNC_COLS = {"id", "created_at", "updated_at", "deleted_at"}


def _is_stub_property(p: dict) -> bool:
    """True for a bare `text` property carrying no refinement beyond what
    `create_table` seeds by default (col:type with no `!`/options/etc) —
    `infer` should still be free to propose a tighter type for these."""
    return p.get("type") in (None, "text") and not any(
        p.get(k)
        for k in (
            "required",
            "options",
            "derived_by",
            "pattern",
            "ref_table",
            "description",
            "immutable",
            "deprecated",
            "default_value",
        )
    )


def infer(path: Path, tbl: str | None = None, min_rows: int = 20) -> list[dict]:
    pkg = _pkg()
    out = []
    with pkg.connect(path) as conn:
        all_tables = [
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            if not r[0].startswith(("_", "sqlite_")) and r[0] not in ENGINE_TABLES
        ]
        tables = [tbl] if tbl else all_tables
        id_sets = {}
        for t in tables:
            n = conn.execute(f"SELECT count(*) FROM {t} WHERE deleted_at IS NULL").fetchone()[0]
            if n < min_rows:
                continue
            known = {p["col"] for p in properties(conn, t) if not _is_stub_property(p)}
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
                    ref = _ref_target(conn, all_tables, vals, id_sets, exclude=t)
                    if ref:
                        prop.update(type="ref", ref_table=ref)
                    else:
                        distinct = sorted(set(map(str, vals)))
                        if len(distinct) <= 20 and len(distinct) / len(vals) < 0.5:
                            prop.update(type="select", options=[{"v": v} for v in distinct])
                out.append(prop)
    return out


def _ref_target(conn, tables, vals, id_sets, exclude):
    fits = []
    for t in sorted(tables):
        if t == exclude:
            continue
        if t not in id_sets:
            id_sets[t] = {r[0] for r in conn.execute(f"SELECT id FROM {t}").fetchall()}
        if id_sets[t] and all(v in id_sets[t] for v in vals):
            fits.append(t)
    return min(fits, key=lambda t: (len(id_sets[t]), t), default=None)


# --- doc ---------------------------------------------------------------------


def _cell(s: str) -> str:
    """Escape a value for a markdown table cell: pipes break columns, newlines break rows."""
    return str(s).replace("|", "\\|").replace("\n", " ")


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
                    f"| {_cell(p['col'])} | {_cell(p.get('type', 'text'))} | "
                    f"{'yes' if p.get('required') else ''} | {_cell(_constraint(p))} | "
                    f"{_cell(p.get('description') or '')} |"
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
