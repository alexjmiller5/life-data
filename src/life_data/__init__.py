"""life-data: schema-agnostic personal data store — local-first SQLite, agent-friendly CLI."""

import argparse
import json
import os
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
CHUNK = 200  # rows per upsert (one JSON parameter regardless of row width)

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


# --- local database ----------------------------------------------------------


def resolve_data_dir() -> Path:
    if override := os.environ.get("LIFE_DATA_DIR"):
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(xdg) / "life-data"


def db_path() -> Path:
    return resolve_data_dir() / "life.db"


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(PLUMBING)
    return path


def execute_sql(path: Path, sql: str) -> list[dict]:
    with connect(path) as conn:
        cur = conn.execute(sql)
        rows = [dict(r) for r in cur.fetchall()]
        first_word = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
        if first_word in DDL_KEYWORDS:
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (sql,))
    return rows


def insert_rows(path: Path, table: str, rows: list[dict]) -> int:
    with connect(path) as conn:
        for row in rows:
            cols = list(row)
            values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]
            placeholders = ", ".join("?" for _ in cols)
            conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})", values)
    return len(rows)


def create_table(path: Path, name: str, columns: list[str]) -> None:
    user_cols = ",\n    ".join(f"{c.split(':')[0]} {c.split(':', 1)[1].upper()}" for c in columns)
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


def load_config(data_dir: Path | None = None) -> dict:
    """Config precedence: env > config.json > defaults. A config file is optional."""
    cfg_path = (data_dir or resolve_data_dir()) / "config.json"
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    cfg.setdefault("hub_url", DEFAULT_HUB_URL)
    cfg["hub_url"] = os.environ.get("LIFE_HUB_URL", cfg["hub_url"]).rstrip("/")
    token = os.environ.get("LIFE_HUB_TOKEN") or cfg.get("token")
    if not token and cfg.get("token_cmd"):
        token = subprocess.run(
            cfg["token_cmd"], shell=True, capture_output=True, text=True, check=True
        ).stdout.strip()
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


def _upsert_sql(table: str, cols: list[str]) -> str:
    # rows travel as ONE json parameter (D1 caps bind params at ~100/query);
    # `WHERE true` disambiguates a SELECT-source upsert for SQLite's parser
    exts = ", ".join(f"json_extract(value, '$.{c}')" for c in cols)
    sets = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "id")
    return (
        f"INSERT INTO {table} ({', '.join(cols)}) "
        f"SELECT {exts} FROM json_each(?) WHERE true "
        f"ON CONFLICT(id) DO UPDATE SET {sets} "
        f"WHERE excluded.updated_at > {table}.updated_at"
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
                msg = str(exc).lower()
                if "already exists" not in msg and "duplicate column" not in msg:
                    raise
            self._query(
                "INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)",
                [e["applied_at"], e["ddl"]],
            )
            applied += 1
        return applied

    def rows_pull(self, table: str, columns: list[str], since: str) -> list[dict]:
        return self._query(
            f"SELECT {', '.join(columns)} FROM {table} WHERE updated_at > ?", [since or ""]
        )

    def rows_push(self, table: str, columns: list[str], rows: list[dict]) -> int:
        for i in range(0, len(rows), CHUNK):
            self._query(_upsert_sql(table, columns), [json.dumps(rows[i : i + CHUNK])])
        return len(rows)

    def cursor(self, tables: list[str]) -> str:
        top = ""
        for t in tables:
            rows = self._query(f"SELECT max(updated_at) AS m FROM {t}")
            top = max(top, rows[0]["m"] or "")
        return top


class HttpHub:
    """Hub reached over HTTP — the deployed service. Knows nothing about any provider."""

    def __init__(self, base_url: str, headers: dict | None = None, timeout: int = 30):
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
        return self._post(
            "/v1/rows/pull", {"table": table, "columns": columns, "since": since or ""}
        )["rows"]

    def rows_push(self, table: str, columns: list[str], rows: list[dict]) -> int:
        total = 0
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i : i + CHUNK]
            total += self._post(
                "/v1/rows/push", {"table": table, "columns": columns, "rows": chunk}
            )["upserted"]
        return total

    def cursor(self, tables: list[str]) -> str:
        return self._post("/v1/cursor", {"tables": tables})["max_updated_at"] or ""

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
    return out.stdout.strip()


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


def _user_tables(path: Path) -> list[str]:
    rows = execute_sql(path, "SELECT name FROM sqlite_master WHERE type = 'table'")
    return [r["name"] for r in rows if not r["name"].startswith(("_", "sqlite_"))]


def _columns(path: Path, table: str) -> list[str]:
    return [r["name"] for r in execute_sql(path, f"PRAGMA table_info({table})")]


def _apply_local_ddl(path: Path, entry: dict) -> None:
    with connect(path) as conn:
        try:
            conn.execute(entry["ddl"])
        except sqlite3.Error as exc:
            msg = str(exc).lower()
            if "already exists" not in msg and "duplicate column" not in msg:
                raise
        conn.execute(
            "INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)",
            (entry["applied_at"], entry["ddl"]),
        )


def sync(path: Path, hub) -> dict:
    """State-based replica sync: schema replay, then pull, then push. LWW on updated_at."""
    hub.ensure_ready()

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
    # ponytail: one global cursor per direction; assumes ~NTP-synced clocks,
    # which holds for one person's devices
    last_pull = _get_state(path, "last_pull")
    last_push = _get_state(path, "last_push")

    pulled = pushed = 0
    for table in tables:
        cols = _columns(path, table)
        # snapshot push candidates BEFORE applying the pull, so pulled rows
        # are never echoed straight back at the hub
        mine = execute_sql(
            path, f"SELECT {', '.join(cols)} FROM {table} WHERE updated_at > '{last_push}'"
        )
        remote = hub.rows_pull(table, cols, last_pull)
        if remote:
            with connect(path) as conn:
                for i in range(0, len(remote), CHUNK):
                    conn.execute(_upsert_sql(table, cols), (json.dumps(remote[i : i + CHUNK]),))
        pulled += len(remote)
        if mine:
            hub.rows_push(table, cols, mine)
        pushed += len(mine)

    _set_state(path, "last_pull", hub.cursor(tables))
    _set_state(path, "last_push", _local_cursor(path, tables))
    return {"pushed": pushed, "pulled": pulled, "ddl_applied": ddl_applied}


def _local_cursor(path: Path, tables: list[str]) -> str:
    top = ""
    for t in tables:
        rows = execute_sql(path, f"SELECT max(updated_at) AS m FROM {t}")
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
            except RuntimeError as e:  # offline or hub down: keep watching
                print(f"sync deferred: {e}", file=sys.stderr, flush=True)
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
    p_watch = sub.add_parser("watch", help="sync continuously (push instantly, poll for pulls)")
    p_watch.add_argument("--poll", type=int, default=POLL_SECONDS)
    p_stream = sub.add_parser("stream", help="append-only stream operations (hub-backed)")
    s_sub = p_stream.add_subparsers(dest="stream_command", required=True)
    p_sappend = s_sub.add_parser("append", help="append one JSON record from stdin")
    p_sappend.add_argument("name")
    p_stail = s_sub.add_parser("tail", help="print the latest record")
    p_stail.add_argument("name")
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
        "--scopes", default="full", help="comma list: full, tables:read, streams:append"
    )
    p_tr = k_sub.add_parser("revoke", help="revoke a token by name")
    p_tr.add_argument("name")
    k_sub.add_parser("list", help="list tokens (names/scopes, never values)")
    p_table = sub.add_parser("table", help="table operations")
    t_sub = p_table.add_subparsers(dest="table_command", required=True)
    p_create = t_sub.add_parser("create", help="create a table with sync columns")
    p_create.add_argument("name")
    p_create.add_argument("columns", nargs="+", metavar="name:type")
    args = parser.parse_args(argv)

    path = db_path()
    if args.command == "init":
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
        print(json.dumps(sync(path, hub_from_config())))
    elif args.command == "watch":
        init(path)
        watch(path, hub_from_config(), poll_seconds=args.poll)
    elif args.command == "stream":
        hub = hub_from_config()
        if args.stream_command == "append":
            print(json.dumps(hub.stream_append(args.name, sys.stdin.read())))
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
        create_table(path, args.name, args.columns)
        print(f"created table {args.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
