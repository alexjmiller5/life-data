"""life-data: schema-agnostic personal data store — local-first SQLite, agent-friendly CLI."""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "0.2.0"
# Default hosted hub. Any deployment can be targeted by setting hub_url in
# config.json, so the client is not tied to this instance.
DEFAULT_HUB_URL = "https://life-data.nqipomyrjb.workers.dev"
POLL_SECONDS = 30  # how often `life watch` pulls remote changes
TICK_SECONDS = 1  # how often `life watch` checks for local changes

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
DDL_KEYWORDS = {"CREATE", "ALTER", "DROP"}
RENAME_TABLE = re.compile(r"^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b", re.IGNORECASE)
CHUNK = 200  # rows per upsert (one JSON parameter regardless of row width)
DERIVE_CHUNK = 50  # max ids per /v1/derive call

PLUMBING_STMTS = [
    f"""CREATE TABLE IF NOT EXISTS _schema_log (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT ({NOW}),
    ddl TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS _sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
)""",
]
PLUMBING = ";\n".join(PLUMBING_STMTS) + ";"

from life_data import catalog

# --- local database ----------------------------------------------------------


def resolve_data_dir() -> Path:
    if override := os.environ.get("LIFE_DATA_DIR"):
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(xdg) / "life-data"


def db_path() -> Path:
    return resolve_data_dir() / "life.db"


SAFE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def qi(name: str) -> str:
    """Quote a table/column name for interpolation into SQL. Mirrors the hub's
    `ident()`: anything that is not a bare identifier is refused rather than
    escaped, so no caller can smuggle SQL through a name."""
    if not SAFE_IDENT.match(name or ""):
        raise ValueError(f"unsafe identifier: {name!r}")
    return f'"{name}"'


class _Connection(sqlite3.Connection):
    """`with connect(...)` closes on exit. The stdlib context manager only
    commits/rolls back, and a connection sits in a reference cycle, so an
    un-closed one holds its files until the cyclic GC gets around to it - a
    daemon under launchd's 256-file cap ran out mid-sync."""

    def __exit__(self, *exc):
        try:
            return super().__exit__(*exc)
        finally:
            self.close()


def connect(path: Path, manual_tx: bool = False) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None if manual_tx else "", factory=_Connection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(PLUMBING)
        upgrade = catalog.has_catalog(conn)
    if upgrade:  # an existing estate: engine tables this version added appear here
        catalog.ensure_catalog(path)
    return path


# `WITH` is deliberately absent: a CTE can end in INSERT/UPDATE/DELETE, so
# every WITH statement goes through the validator (a read-only CTE pays a
# no-op transaction).
READ_KEYWORDS = {"SELECT", "PRAGMA", "EXPLAIN", "VALUES"}


def _first_word(sql: str) -> str:
    return sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""


def execute_sql(path: Path, sql: str) -> list[dict]:
    if RENAME_TABLE.match(sql):
        raise ValueError(
            "renaming a table through SQL leaves the catalog, provenance and history "
            "pointing at the old name - use `life table rename OLD NEW`"
        )
    if _first_word(sql) in READ_KEYWORDS:
        with connect(path) as conn:
            return [dict(r) for r in conn.execute(sql).fetchall()]

    def run(conn):
        rows = [dict(r) for r in conn.execute(sql).fetchall()]
        if _first_word(sql) in DDL_KEYWORDS:
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (sql,))
        return rows

    return catalog.write(path, run, ddl=_first_word(sql) in DDL_KEYWORDS)


def insert_rows(path: Path, table: str, rows: list[dict]) -> int:
    def run(conn):
        for row in rows:
            row = catalog.apply_defaults(conn, table, row)
            cols = list(row)
            values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]
            placeholders = ", ".join("?" for _ in cols)
            conn.execute(
                f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in cols)}) "
                f"VALUES ({placeholders})",
                values,
            )
        return len(rows)

    return catalog.write(path, run)


COLSPEC = re.compile(r"^(?P<col>\w+):(?P<type>\w+)(?P<req>!)?(?:\((?P<opts>[^)]*)\))?$")
# an unrecognized type keeps its raw storage type; the catalog property still
# gets a best-guess catalog type from the storage SQLite ends up with.
_STORAGE_TO_CATALOG_TYPE = {"REAL": "number", "INTEGER": "int"}


def _parse_specs(columns: list[str]) -> list[dict]:
    specs = []
    for c in columns:
        m = COLSPEC.match(c)
        if not m:
            raise ValueError(f"bad column spec {c!r}; expected col:type[!][(a|b)]")
        specs.append(m.groupdict())
    return specs


def _trigger_ddl(name: str) -> str:
    return f"""CREATE TRIGGER {qi(f"{name}_updated_at")} AFTER UPDATE ON {qi(name)} FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE {qi(name)} SET updated_at = ({NOW}) WHERE rowid = NEW.rowid;
END"""


def table_ddl(name: str, columns: list[str]) -> list[str]:
    """The two statements a synced table is made of: CREATE TABLE with the sync
    columns, and its updated_at trigger. One source, so every path that creates
    a table logs byte-identical DDL."""
    specs = _parse_specs(columns)
    user_cols = ",\n    ".join(
        f"{qi(s['col'])} {catalog.STORAGE.get(s['type'].lower(), s['type'].upper())}" for s in specs
    )
    ddl = f"""CREATE TABLE {qi(name)} (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    {user_cols},
    created_at TEXT NOT NULL DEFAULT ({NOW}),
    updated_at TEXT NOT NULL DEFAULT ({NOW}),
    deleted_at TEXT,
    hub_at TEXT
)"""
    return [ddl, _trigger_ddl(name)]


def create_table(path: Path, name: str, columns: list[str]) -> None:
    """Create a table plus a `catalog_properties` row per column.

    Each column is `col:type[!][(a|b|c)]`: `type` is a catalog type (mapped
    to its SQLite storage via `catalog.STORAGE`) or a raw SQLite type used
    as-is; `!` marks the column required; `(a|b|c)` sets select/multi_select
    options.
    """
    specs = _parse_specs(columns)
    ddl, trigger = table_ddl(name, columns)
    execute_sql(path, ddl)
    execute_sql(path, trigger)
    if name in catalog.ENGINE_TABLES:
        return
    for i, s in enumerate(specs):
        t = s["type"].lower()
        storage = catalog.STORAGE.get(t, s["type"].upper())
        cat_type = t if t in catalog.TYPES else _STORAGE_TO_CATALOG_TYPE.get(storage, "text")
        fields = {"type": cat_type, "sort": (i + 1) * 10}
        if s["req"]:
            fields["required"] = 1
        if s["opts"] is not None:
            fields["options"] = [{"v": o.strip()} for o in s["opts"].split("|") if o.strip()]
        catalog.set_property(path, name, s["col"], **fields)


def rename_table(path: Path, old: str, new: str) -> None:
    """Rename a table and every reference to it - catalog rows, refs, rule SQL,
    provenance, history - in one transaction, as logged DDL that replays to
    the hub and every replica. The only sanctioned way to rename a table."""
    qi(new)  # validates the identifier
    if old in catalog.CATALOG_TABLES or old.startswith("_"):
        raise ValueError(f"{old} is an engine table")

    def run(conn):
        if not catalog._table_exists(conn, old):
            raise ValueError(f"no such table: {old}")
        if catalog._table_exists(conn, new):
            raise ValueError(f"table already exists: {new}")
        for stmt in (
            f"ALTER TABLE {qi(old)} RENAME TO {qi(new)}",
            # SQLite rewrites the trigger body itself; the NAME must follow the
            # convention too, or a later `life table create {old}` collides
            f"DROP TRIGGER IF EXISTS {qi(f'{old}_updated_at')}",
            _trigger_ddl(new),
        ):
            conn.execute(stmt)
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (stmt,))
        catalog.rename_refs(conn, old, new)

    catalog.write(path, run, ddl=True)


def dump_sql(path: Path) -> str:
    with connect(path) as conn:
        return "\n".join(conn.iterdump())


def db_version(path: Path) -> tuple:
    """Cheap local-change fingerprint, no queries: size+mtime of the database AND
    its WAL. In WAL mode writes land in the -wal file and leave the main file
    untouched until a checkpoint, so both must be watched."""
    out = []
    for p in (path, Path(f"{path}-wal")):
        try:
            st = p.stat()
            out.append((st.st_size, st.st_mtime_ns))
        except FileNotFoundError:
            out.append(None)
    return tuple(out)


def db_changed(path: Path, previous) -> tuple[bool, tuple]:
    current = db_version(path)
    return current != previous, current


# --- config ------------------------------------------------------------------


def load_config(data_dir: Path | None = None, *, resolve_auth: bool = True) -> dict:
    """Config precedence: env > config.json > defaults. A config file is optional."""
    data_dir = data_dir or resolve_data_dir()
    cfg_path = data_dir / "config.json"
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    from .background import read_json

    prefs = read_json(data_dir / "background.json")
    if prefs.get("hub_url"):
        cfg["hub_url"] = prefs["hub_url"]
    cfg.setdefault("hub_url", DEFAULT_HUB_URL)
    cfg.setdefault("commands", {})
    cfg["hub_url"] = os.environ.get("LIFE_HUB_URL", cfg["hub_url"]).rstrip("/")
    if not resolve_auth:
        return cfg
    token = os.environ.get("LIFE_HUB_TOKEN") or cfg.get("token")
    if not token and cfg.get("token_cmd"):
        token = subprocess.run(
            cfg["token_cmd"], shell=True, capture_output=True, text=True, check=True
        ).stdout.strip()
    if not token and prefs.get("keychain"):
        from .background import keychain_account
        from .credentials import read_token

        token = read_token(keychain_account(data_dir, cfg["hub_url"]))
    cfg["token"] = token
    return cfg


def auth_headers(config: dict) -> dict:
    """Generic credentials: a bearer token plus any extra headers a deployment needs
    (e.g. CF-Access-Client-Id/Secret when the hub sits behind Cloudflare Access)."""
    headers = dict(config.get("headers") or {})
    if config.get("token"):
        headers["Authorization"] = f"Bearer {config['token']}"
    return headers


# --- hubs (sync targets) -----------------------------------------------------


def _upsert_sql(table: str, cols: list[str], stamp_hub_at: bool = False) -> str:
    # rows travel as ONE json parameter (D1 caps bind params at ~100/query);
    # `WHERE true` disambiguates a SELECT-source upsert for SQLite's parser.
    # `stamp_hub_at` is the HUB's role, decided by the HUB's schema: hub_at is
    # dropped from whatever the client sent and re-added bound to the hub's own
    # clock, so a push that omits the column still lands stamped rows. A client
    # applying a pull carries the hub's value through as data.
    t = qi(table)
    # the json path uses the RAW column name (it is a JSON key, not SQL)
    if stamp_hub_at:
        cols = [c for c in cols if c != "hub_at"]
        exts = ", ".join([*(f"json_extract(value, '$.{c}')" for c in cols), "?"])
        cols = [*cols, "hub_at"]
    else:
        exts = ", ".join(f"json_extract(value, '$.{c}')" for c in cols)
    sets = ", ".join(f"{qi(c)} = excluded.{qi(c)}" for c in cols if c != "id")
    return (
        f"INSERT INTO {t} ({', '.join(qi(c) for c in cols)}) "
        f"SELECT {exts} FROM json_each(?) WHERE true "
        f"ON CONFLICT(id) DO UPDATE SET {sets} "
        f"WHERE excluded.updated_at > {t}.updated_at"
    )


class LocalHub:
    """Hub backed by a local SQLite file — used by tests and by the Worker's own logic."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _query(self, sql: str, params: list | tuple = ()) -> list[dict]:
        with connect(self.path) as conn:
            return [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]

    def ensure_ready(self) -> None:
        for stmt in PLUMBING_STMTS:
            self._query(stmt)

    def schema_pull(self) -> list[dict]:
        return self._query("SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")

    def schema_push(self, entries: list[dict]) -> int:
        known = {r["ddl"] for r in self.schema_pull()}
        applied = 0
        for e in entries:
            if e["ddl"] in known:
                continue
            try:
                self._query(e["ddl"])
            except Exception as exc:  # replay skips DDL the hub already has
                if not _already_applied(exc):
                    raise
            self._query(
                "INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)",
                [e["applied_at"], e["ddl"]],
            )
            applied += 1
        return applied

    def _has_hub_at(self, table: str) -> bool:
        return any(r["name"] == "hub_at" for r in self._query(f"PRAGMA table_info({qi(table)})"))

    def rows_pull(self, table: str, columns: list[str], since: str) -> list[dict]:
        sel = ", ".join(qi(c) for c in columns)
        if not self._has_hub_at(table):  # predates the migration: old behaviour
            return self._query(f"SELECT {sel} FROM {qi(table)} WHERE updated_at > ?", [since or ""])
        # arrival-time cursor, INCLUSIVE: a push stamped in the same millisecond
        # as a cursor read must not be lost. A row with a NULL hub_at is older
        # than everything, so `since = ''` pulls the whole table, NULLs included.
        return self._query(
            f"SELECT {sel} FROM {qi(table)} WHERE ? = '' OR hub_at >= ?",
            [since or "", since or ""],
        )

    def rows_push(self, table: str, columns: list[str], rows: list[dict], *, history=None) -> dict:
        qi(table)
        for col in columns:
            qi(col)
        rows = [{col: row[col] for col in columns if col in row} for row in rows]
        rejected, accepted = [], []
        with connect(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            stamping = any(
                r["name"] == "hub_at" for r in conn.execute(f"PRAGMA main.table_info({qi(table)})")
            )
            now = conn.execute(f"SELECT {NOW}").fetchone()[0]
            hub_at = now if stamping else ""
            # Facts imported by an earlier row can still explain a later revision
            # in this batch, but facts present before the batch cannot be reused.
            has_history = catalog._table_exists(conn, "history")
            remaining = [
                e
                for e in (history or [])
                if not has_history
                or not conn.execute("SELECT 1 FROM history WHERE id=?", (e.get("id"),)).fetchone()
            ]
            history_batch = {"events": remaining, "matched": {}}
            for row in rows:
                if not catalog.valid_edit_timestamp(row.get("updated_at")):
                    rejected.append(
                        {
                            "id": row.get("id"),
                            "col": "updated_at",
                            "rule": "required" if row.get("updated_at") is None else "type",
                            "message": "updated_at must be a valid UTC millisecond timestamp.",
                        }
                    )
                    continue
                before = conn.execute(
                    f"SELECT * FROM {qi(table)} WHERE id = ?", (row.get("id"),)
                ).fetchone()
                stale = before and row["updated_at"] <= before["updated_at"]
                conn.execute("SAVEPOINT pushed_row")
                try:
                    events = [e for e in (history or []) if e.get("row_id") == row.get("id")]
                    _, violations = ([], []) if stale else catalog.validate_push(conn, table, [row])
                    if not violations and not stale:
                        conn.execute(
                            f"CREATE TEMP TABLE temp.{qi('_before_' + table)} AS SELECT * FROM main.{qi(table)} WHERE id = ?",
                            (row.get("id"),),
                        )
                        blob = json.dumps([row])
                        conn.execute(
                            _upsert_sql(table, list(row), stamp_hub_at=stamping),
                            [hub_at, blob] if stamping else [blob],
                        )
                        actual = dict(
                            conn.execute(
                                f"SELECT * FROM {qi(table)} WHERE id=?", (row["id"],)
                            ).fetchone()
                        )
                        _, violations = catalog.validate_push(
                            conn,
                            table,
                            [row],
                            before_rows={row["id"]: dict(before) if before else None},
                            after_rows={row["id"]: actual},
                        )
                        if (
                            not catalog.valid_edit_timestamp(actual.get("updated_at"))
                            or actual.get("updated_at") != row["updated_at"]
                        ):
                            violations.append(
                                {
                                    "id": row["id"],
                                    "col": "updated_at",
                                    "rule": "type",
                                    "message": "Stored updated_at must match the canonical pushed timestamp.",
                                }
                            )
                        for rule in catalog.rules(conn, tbl=table, kind="invariant"):
                            if rule.get("enforce") and rule.get("tbl") == table:
                                for hit in catalog.run_invariant(
                                    conn, rule, changed_ids=[row.get("id")], now=now
                                ):
                                    violations.append(
                                        {
                                            "id": row.get("id"),
                                            "col": rule.get("col"),
                                            "rule": rule["id"],
                                            "message": rule["text"],
                                        }
                                    )
                        conn.execute(f"DROP TABLE temp.{qi('_before_' + table)}")
                    if not violations:
                        try:
                            catalog.push_history(
                                conn,
                                table,
                                row,
                                dict(before) if before else None,
                                events,
                                now,
                                history_batch,
                            )
                        except ValueError as exc:
                            violations.append(
                                {
                                    "id": row.get("id"),
                                    "col": None,
                                    "rule": "history",
                                    "message": str(exc),
                                }
                            )
                    if violations:
                        conn.execute("ROLLBACK TO pushed_row")
                        rejected.extend(violations)
                    else:
                        accepted.append(row)
                except catalog._HistoryAmbiguity:
                    # Earlier revisions may have imported all originals. Roll back
                    # the request rather than preserve a misleading partial history.
                    conn.rollback()
                    return {
                        "upserted": 0,
                        "rejected": [
                            {
                                "id": submitted.get("id"),
                                "col": None,
                                "rule": "history-ambiguity",
                                "retryable": True,
                                "message": "History matching budget exhausted; split revisions into smaller requests and retry.",
                            }
                            for submitted in rows
                        ],
                        "hub_at": "",
                    }
                finally:
                    if conn.in_transaction:
                        conn.execute("RELEASE pushed_row")
        return {"upserted": len(accepted), "rejected": rejected, "hub_at": hub_at}

    def cursor(self, tables: list[str]) -> str:
        top = ""
        for t in tables:
            col = "hub_at" if self._has_hub_at(t) else "updated_at"
            rows = self._query(f"SELECT max({col}) AS m FROM {qi(t)}")
            top = max(top, rows[0]["m"] or "")
        return top

    def derive(self, table: str, ids: list[str], col: str | None = None) -> dict:
        return {"derived": 0, "failed": []}  # derivations run on the hub only


class HttpHub:
    """Hub reached over HTTP — the deployed service. Knows nothing about any provider."""

    def __init__(self, base_url: str, headers: dict | None = None, timeout: int = 120):
        self.base = base_url.rstrip("/")
        # A real User-Agent is REQUIRED, not cosmetic: Cloudflare's edge bot
        # protection 403s (error 1010) the default "Python-urllib/x.y" agent
        # before the request ever reaches the Worker.
        self.headers = {"User-Agent": f"life-data/{VERSION}", **dict(headers or {})}
        self.timeout = timeout

    def _post(self, route: str, body: dict) -> dict:
        req = urllib.request.Request(
            f"{self.base}{route}",
            data=json.dumps(body).encode(),
            headers={**self.headers, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"hub HTTP {e.code}: {e.read().decode()[:300]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"hub unreachable: {e.reason}") from e

    def ensure_ready(self) -> None:
        return None  # the service owns its own plumbing

    def schema_pull(self) -> list[dict]:
        return self._post("/v1/schema/pull", {})["entries"]

    def schema_push(self, entries: list[dict]) -> int:
        return self._post("/v1/schema/push", {"entries": entries})["applied"]

    def rows_pull(self, table: str, columns: list[str], since: str) -> list[dict]:
        body = {"table": table, "columns": columns, "since": since or "", "limit": CHUNK}
        rows = []
        while True:
            page = self._post("/v1/rows/pull", body)
            rows.extend(page["rows"])
            cursor = page.get("next_cursor")
            if cursor is None:  # Older hubs return a complete response without a cursor.
                return rows
            if not isinstance(cursor, str) or cursor <= body.get("after", "") or not page["rows"]:
                raise RuntimeError("invalid pull cursor")
            body["after"] = cursor

    def rows_push(self, table: str, columns: list[str], rows: list[dict], *, history=None) -> dict:
        # the response also carries the hub_at the hub stamped; nothing reads it
        # - the pull cursor never advances on a push
        total, rejected = 0, []
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i : i + CHUNK]
            body = {"table": table, "columns": columns, "rows": chunk}
            if history:
                ids = {r["id"] for r in chunk}
                body["history"] = [e for e in history if e["row_id"] in ids]
            out = self._post("/v1/rows/push", body)
            total += out["upserted"]
            rejected += out.get("rejected", [])
        return {"upserted": total, "rejected": rejected}

    def cursor(self, tables: list[str]) -> str:
        return self._post("/v1/cursor", {"tables": tables}).get("max_hub_at") or ""

    def derive(self, table: str, ids: list[str], col: str | None = None) -> dict:
        body = {"table": table, "ids": ids}
        if col:
            body["col"] = col
        return self._post("/v1/derive", body)

    def _get(self, route: str) -> dict | list | None:
        req = urllib.request.Request(f"{self.base}{route}", headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"hub HTTP {e.code}: {e.read().decode()[:300]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"hub unreachable: {e.reason}") from e

    def stream_append(self, name: str, body: str) -> dict:
        return self._post(f"/v1/streams/{name}/append", json.loads(body))

    def stream_tail(self, name: str):
        return self._get(f"/v1/streams/{name}/tail")

    def stream_manifest(self, name: str) -> dict:
        return self._get(f"/v1/streams/{name}/manifest")

    def stream_batch(self, name: str, records: list) -> dict:
        return self._post(f"/v1/streams/{name}/batch", records)

    def archive_query(self, sql: str) -> dict:
        return self._post("/v1/archive/query", {"sql": sql})

    def token_create(self, name: str, scopes: str) -> dict:
        return self._post("/v1/tokens/create", {"name": name, "scopes": scopes})

    def token_revoke(self, name: str) -> dict:
        return self._post("/v1/tokens/revoke", {"name": name})

    def token_list(self) -> list:
        return self._post("/v1/tokens/list", {})


def hub_from_config(config: dict | None = None) -> HttpHub:
    cfg = config or load_config()
    return HttpHub(cfg["hub_url"], auth_headers(cfg))


# --- streams & archive -------------------------------------------------------

STREAM_RE = r"stream\('([A-Za-z0-9_-]+)'\)"


def expand_stream_sql(sql: str, manifests: dict) -> str:
    """Rewrite stream('name') into DuckDB source unions over the manifest URLs."""
    import re

    def source(match) -> str:
        m = manifests[match.group(1)]
        parts = []
        if m["parquet"]:
            parts.append(
                f"SELECT * FROM read_parquet({json.dumps(m['parquet'])}, union_by_name=true)"
            )
        if m["landing"]:
            parts.append(f"SELECT * FROM read_json({json.dumps(m['landing'])}, union_by_name=true)")
        if not parts:
            raise RuntimeError(f"stream '{match.group(1)}' is empty")
        return "(" + " UNION ALL BY NAME ".join(parts) + ")"

    return re.sub(STREAM_RE, source, sql)


def archive_query_duckdb(sql: str, config: dict) -> str:
    """Fallback query path: expand stream() refs over the manifest and run the SQL
    through the local duckdb CLI against landing/parquet URLs. Exists because R2 SQL
    (the default path, proxied by the hub) is beta — this reads the raw objects.
    The SQL script travels on stdin so the token never appears in `ps`."""
    import re
    import shutil

    duck = shutil.which("duckdb")
    if not duck:
        raise SystemExit("duckdb not found on PATH — install it (nix: pkgs.duckdb)")
    hub = hub_from_config(config)
    names = set(re.findall(STREAM_RE, sql))
    manifests = {n: hub.stream_manifest(n) for n in names}
    headers = auth_headers(config)
    header_map = ", ".join(f"'{k}': '{v}'" for k, v in headers.items())
    script = (
        "INSTALL httpfs; LOAD httpfs;\n"
        f"CREATE SECRET hub (TYPE http, EXTRA_HTTP_HEADERS MAP {{{header_map}}});\n"
        + expand_stream_sql(sql, manifests)
        + ";\n"
    )
    out = subprocess.run(  # noqa: PLW1510 — non-zero handled explicitly below
        [duck, "-json"], input=script, capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(f"duckdb failed: {out.stderr.strip()[:500]}")
    # drop the CREATE SECRET statement's own result line
    lines = [ln for ln in out.stdout.strip().splitlines() if ln.strip() != '[{"Success":true}]']
    return "\n".join(lines)


# --- sync --------------------------------------------------------------------


def _get_state(path: Path, key: str) -> str:
    rows = execute_sql(path, f"SELECT value FROM _sync_state WHERE key = '{key}'")
    return rows[0]["value"] if rows else ""


def _set_state(path: Path, key: str, value: str) -> None:
    with connect(path) as conn:
        conn.execute(
            "INSERT INTO _sync_state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def _already_applied(exc: Exception, ddl: str = "") -> bool:
    """Replay is idempotent-by-skip: a CREATE that already exists, an ADD of a
    column already there, a RENAME of a column that is already gone (a fresh
    replica creates engine tables in their current shape, then replays the log
    that got them there), or a table RENAME whose source is already gone."""
    msg = str(exc).lower()
    if "already exists" in msg or "duplicate column" in msg or "no such column" in msg:
        return True
    return "no such table" in msg and bool(RENAME_TABLE.match(ddl))


def _user_tables(path: Path) -> list[str]:
    """catalog_* and provenance first, so a replica always has the contract
    (and the provenance backing derived columns) before the data it governs."""
    rows = execute_sql(path, "SELECT name FROM sqlite_master WHERE type = 'table'")
    names = [r["name"] for r in rows if not r["name"].startswith(("_", "sqlite_"))]
    first = [n for n in names if n.startswith("catalog_") or n == "provenance"]
    return sorted(first) + sorted(n for n in names if n not in first)


def _columns(path: Path, table: str) -> list[str]:
    return [r["name"] for r in execute_sql(path, f"PRAGMA table_info({qi(table)})")]


def _apply_local_ddl(path: Path, entry: dict) -> None:
    with connect(path) as conn:
        try:
            conn.execute(entry["ddl"])
        except sqlite3.Error as exc:
            if not _already_applied(exc, entry["ddl"]):
                raise
        conn.execute(
            "INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)",
            (entry["applied_at"], entry["ddl"]),
        )


def ensure_hub_at(path: Path) -> bool:
    """Give every user table the hub's arrival-time column. Logged DDL, so one
    replica adding it replays to the hub and to every other replica. Returns
    True if anything was added — the caller then owes one full pull, because
    every existing row still has a NULL hub_at."""
    added = False
    for t in _user_tables(path):
        if "hub_at" in _columns(path, t):
            continue
        # The literal DEFAULT backfills every existing row, and because the DDL
        # replays verbatim, the hub and every other replica backfill to the SAME
        # stamp. Without it those rows keep a NULL hub_at, the hub's cursor stays
        # empty, and every sync re-pulls the whole table forever.
        stamp = execute_sql(path, f"SELECT {NOW} AS t")[0]["t"]
        try:
            execute_sql(path, f"ALTER TABLE {qi(t)} ADD COLUMN hub_at TEXT DEFAULT '{stamp}'")
            added = True
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise
    return added


def sync(path: Path, hub) -> dict:
    """State-based replica sync: schema replay, then pull, then push. LWW on updated_at."""
    unbound_hub = False
    if isinstance(hub, HttpHub):
        previous_hub = _get_state(path, "hub_url")
        unbound_hub = not previous_hub
        if previous_hub and previous_hub != hub.base:
            raise ValueError("hub changed; use a fresh data directory for a different hub")
    hub.ensure_ready()
    # before the schema replay, so the ALTERs travel to the hub in this sync
    upgraded = ensure_hub_at(path)

    local_log = execute_sql(path, "SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")
    hub_log = hub.schema_pull()
    hub_ddls = {e["ddl"] for e in hub_log}
    local_ddls = {e["ddl"] for e in local_log}

    ddl_applied = hub.schema_push([e for e in local_log if e["ddl"] not in hub_ddls])
    for entry in hub_log:
        if entry["ddl"] not in local_ddls:
            _apply_local_ddl(path, entry)
            ddl_applied += 1

    tables = _user_tables(path)
    # The PULL cursor is hub-clock (`hub_at`, assigned on arrival); the PUSH
    # cursor stays local `updated_at` (which rows of ours are new).
    # A table that just gained hub_at has NULL for every existing row, so the
    # stored cursor would skip all of them: one full pull sets that right.
    # Cursors without an endpoint cannot be trusted. A first HTTP sync
    # verifies the full replica; subsequent rounds use the bound cursors.
    last_pull = "" if upgraded or unbound_hub else _get_state(path, "last_pull")
    last_push = "" if unbound_hub else _get_state(path, "last_push")
    # capture the pull cursor BEFORE pulling: the hub writes rows itself
    # (derivations on push and on cron), and anything it writes after this read
    # gets hub_at > pull_cursor, so the next sync still sees it.
    pull_cursor = hub.cursor(tables)

    # One local read transaction captures rows, original events and the push
    # cursor together. A local edit during network work belongs to next sync.
    with connect(path) as snapshot:
        snapshot.execute("BEGIN")
        candidates, columns = {}, {}
        push_cursor = ""
        for table in tables:
            columns[table] = [
                r["name"] for r in snapshot.execute(f"PRAGMA table_info({qi(table)})")
            ]
            candidates[table] = [
                dict(r)
                for r in snapshot.execute(
                    f"SELECT * FROM {qi(table)} WHERE updated_at > ?", (last_push,)
                )
            ]
            top = snapshot.execute(f"SELECT max(updated_at) FROM {qi(table)}").fetchone()[0]
            push_cursor = max(push_cursor, top or "")
        pending_history = (
            [
                dict(r)
                for r in snapshot.execute(
                    "SELECT * FROM history WHERE updated_at >= ?", (last_push,)
                )
            ]
            if "history" in tables
            else []
        )
    withheld = set()
    tables = [t for t in tables if t != "history"] + (["history"] if "history" in tables else [])
    pulled = pushed = 0
    rejected = []
    for table in tables:
        cols, mine = columns[table], candidates[table]
        remote = hub.rows_pull(table, cols, last_pull)
        if remote:
            # `pulled` counts rows the LWW upsert actually APPLIED, not rows
            # received: the sync after a push re-reads its own rows (stamped
            # after this cursor was read) and they land on nothing.
            with connect(path) as conn:
                for i in range(0, len(remote), CHUNK):
                    cur = conn.execute(
                        _upsert_sql(table, cols), (json.dumps(remote[i : i + CHUNK]),)
                    )
                    pulled += cur.rowcount
        if table == "history":
            mine = [r for r in mine if r["id"] not in withheld]
        if mine:
            ids = {r["id"] for r in mine}
            events = [e for e in pending_history if e["tbl"] == table and e["row_id"] in ids]
            out = hub.rows_push(table, cols, mine, **({"history": events} if events else {}))
            bad = {r["id"] for r in out["rejected"]}
            withheld.update(e["id"] for e in events if e["row_id"] in bad)
            rejected += [{"table": table, **r} for r in out["rejected"]]
            pushed += out["upserted"]

    _set_state(path, "last_pull", pull_cursor)
    if not rejected:
        _set_state(path, "last_push", push_cursor)
        if isinstance(hub, HttpHub):
            _set_state(path, "hub_url", hub.base)
    return {"pushed": pushed, "pulled": pulled, "ddl_applied": ddl_applied, "rejected": rejected}


def _local_cursor(path: Path, tables: list[str]) -> str:
    top = ""
    for t in tables:
        rows = execute_sql(path, f"SELECT max(updated_at) AS m FROM {qi(t)}")
        top = max(top, rows[0]["m"] or "")
    return top


def watch(path: Path, hub, poll_seconds: int = POLL_SECONDS, once: bool = False) -> None:
    """Push local changes within ~1s; pull remote changes every poll_seconds."""
    state = db_version(path)
    last_poll = 0.0
    while True:
        changed, state = db_changed(path, state)
        due = (time.monotonic() - last_poll) >= poll_seconds
        if changed or due:
            try:
                stats = sync(path, hub)
                if stats["pushed"] or stats["pulled"] or stats["ddl_applied"]:
                    print(json.dumps(stats), flush=True)
            except Exception as e:  # noqa: BLE001 - offline, hub down, or a local
                # hiccup: keep watching. A launchd restart re-runs the credential
                # command, and that budget is finite.
                print(f"sync deferred: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            if changed:
                try:
                    findings = catalog.check(path)
                    if findings:
                        print(json.dumps({"check": findings}), file=sys.stderr, flush=True)
                except Exception as e:  # noqa: BLE001 - never kill the daemon
                    print(f"check failed: {e}", file=sys.stderr, flush=True)
            state = db_version(path)
            last_poll = time.monotonic()
        if once:
            return
        time.sleep(TICK_SECONDS)


# --- CLI ---------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="life", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="create the data dir and database")
    sub.add_parser("path", help="print the database path")
    sub.add_parser("export", help="dump the whole database as SQL text to stdout")
    p_sql = sub.add_parser("sql", help="execute one SQL statement, results as JSON")
    p_sql.add_argument("statement")
    p_insert = sub.add_parser("insert", help="bulk-insert rows from a JSON array on stdin")
    p_insert.add_argument("table")
    sub.add_parser("sync", help="sync once with the hub")
    p_check = sub.add_parser("check", help="whole-estate read-only report of catalog violations")
    p_check.add_argument("--as-of", dest="as_of")
    p_audit = sub.add_parser("audit", help="run audit rules' commands, report findings")
    p_audit.add_argument("id", nargs="?", help="run only this rule")
    p_infer = sub.add_parser("infer", help="propose catalog properties for uncataloged columns")
    p_infer.add_argument("table", nargs="?")
    p_infer.add_argument(
        "--apply", action="store_true", help="write the proposals via property set"
    )
    p_infer.add_argument("--min-rows", dest="min_rows", type=int, default=20)
    p_doc = sub.add_parser("doc", help="render the catalog as markdown")
    p_doc.add_argument("table", nargs="?")
    p_watch = sub.add_parser("watch", help="sync continuously (push instantly, poll for pulls)")
    p_watch.add_argument("--poll", type=int, default=POLL_SECONDS)
    p_login = sub.add_parser("login", help="enroll this device through the browser")
    p_login.add_argument("--hub-url", help="hub endpoint (optional for the hosted service)")
    p_login.add_argument("--name", help="label shown in the device approval page")
    p_login.add_argument(
        "--no-browser", action="store_true", help="print the approval URL without opening it"
    )
    p_login.add_argument(
        "--token-stdin",
        action="store_true",
        help="validate and save an existing device token from stdin",
    )
    sub.add_parser("logout", help="revoke and remove this device credential")
    p_background = sub.add_parser("background", help="enable, disable or inspect background sync")
    bg_sub = p_background.add_subparsers(dest="background_command", required=True)
    bg_enable = bg_sub.add_parser("enable", help="turn on background sync")
    bg_enable.add_argument("--hub-url", help="hub endpoint (optional for the hosted service)")
    bg_auth = bg_enable.add_mutually_exclusive_group()
    bg_auth.add_argument(
        "--token-stdin", action="store_true", help="save a token from stdin in macOS Keychain"
    )
    bg_auth.add_argument("--token-command", help="command that supplies the background token")
    bg_sub.add_parser("disable", help="stop syncing after the current round finishes")
    bg_sub.add_parser("status", help="show enabled state, runner and last sync result")
    bg_run = bg_sub.add_parser(
        "run", help="supervised runner (provided by the Home Manager module)"
    )
    bg_run.add_argument("--poll", type=int, default=POLL_SECONDS)
    p_derive = sub.add_parser(
        "derive", help="request the hub derive a column for rows selected locally"
    )
    p_derive.add_argument("ref", help="<table>.<column>")
    p_derive.add_argument("--where", help="SQL WHERE clause narrowing which rows to derive")
    p_stream = sub.add_parser("stream", help="append-only stream operations (hub-backed)")
    s_sub = p_stream.add_subparsers(dest="stream_command", required=True)
    p_sappend = s_sub.add_parser("append", help="append one JSON record from stdin")
    p_sappend.add_argument("name")
    p_stail = s_sub.add_parser("tail", help="print the latest record")
    p_stail.add_argument("name")
    p_simport = s_sub.add_parser(
        "import", help="bulk-import records (NDJSON or a JSON array on stdin), batched"
    )
    p_simport.add_argument("name")
    p_simport.add_argument("--chunk", type=int, default=500)
    p_archive = sub.add_parser("archive", help="analytical queries over streams (DuckDB)")
    a_sub = p_archive.add_subparsers(dest="archive_command", required=True)
    p_aq = a_sub.add_parser("query", help="SQL over the archive (life.events), results as JSON")
    p_aq.add_argument("statement")
    p_aq.add_argument(
        "--raw",
        action="store_true",
        help="query raw landing/parquet objects with local duckdb via stream('name') sources",
    )
    p_token = sub.add_parser("token", help="scoped client tokens (admin token required)")
    k_sub = p_token.add_subparsers(dest="token_command", required=True)
    p_tc = k_sub.add_parser("create", help="mint a scoped token (value shown ONCE)")
    p_tc.add_argument("name")
    p_tc.add_argument(
        "--scopes",
        default="full",
        help="comma list: full, tables:read, tables:write, streams:append",
    )
    p_tr = k_sub.add_parser("revoke", help="revoke a token by name")
    p_tr.add_argument("name")
    k_sub.add_parser("list", help="list tokens (names/scopes, never values)")
    p_table = sub.add_parser("table", help="table operations")
    t_sub = p_table.add_subparsers(dest="table_command", required=True)
    p_create = t_sub.add_parser("create", help="create a table with sync columns")
    p_create.add_argument("name")
    p_create.add_argument("columns", nargs="+", metavar="name:type")
    t_rename = t_sub.add_parser(
        "rename", help="rename a table and every catalog/provenance/history reference to it"
    )
    t_rename.add_argument("old")
    t_rename.add_argument("new")
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
    args = parser.parse_args(argv)

    path = db_path()
    try:
        return _dispatch(args, path)
    except catalog.ValidationError as e:
        print(
            json.dumps({"rejected": [v.as_dict() for v in e.violations]}, indent=2), file=sys.stderr
        )
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _dispatch(args: argparse.Namespace, path: Path) -> int:
    if args.command == "background":
        from .background import command

        if args.background_command == "run" and args.poll < 1:
            raise ValueError("poll interval must be at least one second")
        return command(args, path.parent)
    elif args.command == "login":
        from .login import login

        print(
            json.dumps(
                login(
                    path.parent,
                    hub_url=args.hub_url,
                    name=args.name,
                    no_browser=args.no_browser,
                    token_stdin=args.token_stdin,
                )
            )
        )
    elif args.command == "logout":
        from .login import logout

        print(json.dumps(logout(path.parent)))
    elif args.command == "init":
        init(path)
        print(path)
    elif args.command == "path":
        print(path)
    elif args.command == "export":
        print(dump_sql(path))
    elif args.command == "sql":
        print(json.dumps(execute_sql(path, args.statement), indent=2))
    elif args.command == "insert":
        n = insert_rows(path, args.table, json.load(sys.stdin))
        print(f"inserted {n} rows into {args.table}")
    elif args.command == "sync":
        stats = sync(path, hub_from_config())
        print(json.dumps(stats))
        if stats["rejected"]:
            print(json.dumps({"rejected": stats["rejected"]}, indent=2), file=sys.stderr)
    elif args.command == "check":
        findings = catalog.check(path, as_of=args.as_of)
        print(json.dumps(findings, indent=2))
        return 1 if findings else 0
    elif args.command == "audit":
        findings = catalog.audit(path, rule_id=args.id, commands=load_config().get("commands"))
        print(json.dumps(findings, indent=2))
        return 1 if findings else 0
    elif args.command == "infer":
        proposals = catalog.infer(path, args.table, min_rows=args.min_rows)
        print(json.dumps(proposals, indent=2))
        if args.apply:
            for p in proposals:
                kwargs = {k: v for k, v in p.items() if k not in ("tbl", "col")}
                catalog.set_property(path, p["tbl"], p["col"], **kwargs)
            print(f"applied {len(proposals)}")
    elif args.command == "doc":
        with connect(path) as conn:
            print(catalog.doc(conn, args.table), end="")
    elif args.command == "watch":
        init(path)
        watch(path, hub_from_config(), poll_seconds=args.poll)
    elif args.command == "derive":
        tbl, col = args.ref.split(".", 1)
        cfg = load_config()
        if not cfg.get("token"):
            print(
                "life derive requires a hub token: set LIFE_HUB_TOKEN, config.json's "
                "token, or token_cmd",
                file=sys.stderr,
            )
            return 1
        where = f" AND ({args.where})" if args.where else ""
        ids = [
            r["id"]
            for r in execute_sql(path, f"SELECT id FROM {qi(tbl)} WHERE deleted_at IS NULL{where}")
        ]
        hub = hub_from_config(cfg)
        derived, failed = 0, []
        for i in range(0, len(ids), DERIVE_CHUNK):
            out = hub.derive(tbl, ids[i : i + DERIVE_CHUNK], col)
            derived += out["derived"]
            failed += out.get("failed", [])
        print(json.dumps({"derived": derived, "failed": failed}))
        return 1 if failed else 0
    elif args.command == "stream":
        hub = hub_from_config()
        if args.stream_command == "append":
            print(json.dumps(hub.stream_append(args.name, sys.stdin.read())))
        elif args.stream_command == "import":
            raw = sys.stdin.read().strip()
            records = (
                json.loads(raw)
                if raw.startswith("[")
                else [json.loads(line) for line in raw.splitlines() if line.strip()]
            )
            total = 0
            for i in range(0, len(records), args.chunk):
                total += hub.stream_batch(args.name, records[i : i + args.chunk])["count"]
                print(f"  {total}/{len(records)}", file=sys.stderr)
            print(json.dumps({"imported": total}))
        else:
            print(json.dumps(hub.stream_tail(args.name), indent=2))
    elif args.command == "archive":
        if args.raw:
            print(archive_query_duckdb(args.statement, load_config()))
        else:
            print(json.dumps(hub_from_config().archive_query(args.statement), indent=2))
    elif args.command == "token":
        hub = hub_from_config()
        if args.token_command == "create":
            print(json.dumps(hub.token_create(args.name, args.scopes), indent=2))
        elif args.token_command == "revoke":
            print(json.dumps(hub.token_revoke(args.name)))
        else:
            print(json.dumps(hub.token_list(), indent=2))
    elif args.command == "table":
        if args.table_command == "create":
            create_table(path, args.name, args.columns)
            print(f"created table {args.name}")
        elif args.table_command == "rename":
            rename_table(path, args.old, args.new)
            print(f"renamed {args.old} -> {args.new}")
        else:
            fields = {
                k: v
                for k, v in vars(args).items()
                if k
                in (
                    "kind",
                    "purpose",
                    "id_semantics",
                    "provenance",
                    "owner",
                    "consumers",
                    "description",
                )
                and v is not None
            }
            if "consumers" in fields:
                raw = fields["consumers"].strip()
                fields["consumers"] = (
                    json.loads(raw) if raw.startswith("[") else [s.strip() for s in raw.split(",")]
                )
            print(json.dumps(catalog.set_table(path, args.name, **fields), indent=2))
    elif args.command == "property":
        if args.property_command == "set":
            tbl, col = args.ref.split(".", 1)
            skip = {"command", "property_command", "ref"}
            fields = {k: v for k, v in vars(args).items() if k not in skip and v is not None}
            if "options" in fields:
                raw = fields["options"].strip()
                fields["options"] = (
                    json.loads(raw)
                    if raw.startswith("[")
                    else [{"v": s.strip()} for s in raw.split(",")]
                )
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
