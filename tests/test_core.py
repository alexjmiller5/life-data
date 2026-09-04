import io
import json
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import pytest

from life_data import (
    DEFAULT_HUB_URL,
    NOW,
    HttpHub,
    LocalHub,
    auth_headers,
    catalog,
    connect,
    create_table,
    db_changed,
    db_version,
    dump_sql,
    execute_sql,
    init,
    insert_rows,
    load_config,
    main,
    resolve_data_dir,
    sync,
    watch,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "life.db")


@pytest.fixture()
def hub(tmp_path):
    return LocalHub(tmp_path / "hub.db")


def _mk_people(path, names):
    create_table(path, "people", ["name:text"])
    insert_rows(path, "people", [{"name": n} for n in names])


# --- data dir & config -------------------------------------------------------


def test_resolve_data_dir_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path / "custom"))
    assert resolve_data_dir() == tmp_path / "custom"


def test_resolve_data_dir_xdg(monkeypatch, tmp_path):
    monkeypatch.delenv("LIFE_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert resolve_data_dir() == tmp_path / "xdg" / "life-data"


def test_config_defaults_to_hosted_hub_without_a_config_file(monkeypatch, tmp_path):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_TOKEN", "tok")
    cfg = load_config()
    assert cfg["hub_url"] == DEFAULT_HUB_URL
    assert cfg["token"] == "tok"


def test_config_file_overrides_url_and_token(monkeypatch, tmp_path):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    (tmp_path / "config.json").write_text(
        json.dumps({"hub_url": "https://self.hosted", "token": "abc"})
    )
    cfg = load_config()
    assert cfg["hub_url"] == "https://self.hosted"
    assert cfg["token"] == "abc"


def test_config_token_cmd_is_optional_shell_indirection(monkeypatch, tmp_path):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    (tmp_path / "config.json").write_text(json.dumps({"token_cmd": "printf secret"}))
    assert load_config()["token"] == "secret"


def test_env_token_wins_over_config(monkeypatch, tmp_path):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_TOKEN", "fromenv")
    (tmp_path / "config.json").write_text(json.dumps({"token": "fromfile"}))
    assert load_config()["token"] == "fromenv"


def test_auth_headers_are_generic_bearer_plus_optional_extras():
    h = auth_headers({"token": "abc", "headers": {"CF-Access-Client-Id": "x"}})
    assert h["Authorization"] == "Bearer abc"
    assert h["CF-Access-Client-Id"] == "x"


# --- local database ----------------------------------------------------------


def test_init_creates_plumbing_and_is_idempotent(tmp_path):
    path = tmp_path / "nested" / "life.db"
    init(path)
    init(path)
    conn = sqlite3.connect(path)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"_schema_log", "_sync_state"} <= tables
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_sql_select_returns_rows_as_dicts(db):
    assert execute_sql(db, "SELECT 1 AS one, 'a' AS letter") == [{"one": 1, "letter": "a"}]


def test_ddl_is_recorded_in_schema_log(db):
    execute_sql(db, "CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)")
    assert execute_sql(db, "SELECT ddl FROM _schema_log") == [
        {"ddl": "CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)"}
    ]


def test_non_ddl_is_not_recorded(db):
    execute_sql(db, "CREATE TABLE pets (id TEXT PRIMARY KEY)")
    execute_sql(db, "INSERT INTO pets (id) VALUES ('x')")
    assert len(execute_sql(db, "SELECT ddl FROM _schema_log")) == 1


def test_create_table_adds_sync_columns(db):
    create_table(db, "people", ["name:text", "birthday:text"])
    cols = {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert {"id", "name", "birthday", "created_at", "updated_at", "deleted_at"} <= cols


def test_create_table_autofills_id_and_timestamps(db):
    create_table(db, "people", ["name:text"])
    execute_sql(db, "INSERT INTO people (name) VALUES ('Ada')")
    row = execute_sql(db, "SELECT id, created_at, updated_at FROM people")[0]
    assert len(row["id"]) == 32
    assert row["created_at"] == row["updated_at"]


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


def test_create_table_unknown_type_maps_storage_to_catalog_type(db):
    from life_data.catalog import properties

    create_table(db, "trips", ["lat:real", "n:integer"])
    cols = {r["name"]: r["type"] for r in execute_sql(db, "PRAGMA table_info(trips)")}
    assert cols["lat"] == "REAL" and cols["n"] == "INTEGER"
    with connect(db) as conn:
        p = {x["col"]: x for x in properties(conn, "trips")}
    assert p["lat"]["type"] == "number"
    assert p["n"]["type"] == "int"


def test_update_bumps_updated_at(db):
    create_table(db, "people", ["name:text"])
    execute_sql(db, "INSERT INTO people (name) VALUES ('Ada')")
    before = execute_sql(db, "SELECT updated_at FROM people")[0]["updated_at"]
    time.sleep(0.002)
    execute_sql(db, "UPDATE people SET name = 'Grace'")
    assert execute_sql(db, "SELECT updated_at FROM people")[0]["updated_at"] > before


def test_insert_rows_bulk_and_json_columns(db):
    create_table(db, "people", ["name:text", "tags:text"])
    n = insert_rows(db, "people", [{"name": "Ada", "tags": ["friend"]}, {"name": "Grace"}])
    assert n == 2
    tags = execute_sql(db, "SELECT tags FROM people WHERE name = 'Ada'")[0]["tags"]
    assert json.loads(tags) == ["friend"]


def test_insert_rows_preserves_explicit_id_and_created_at(db):
    create_table(db, "people", ["name:text"])
    insert_rows(
        db, "people", [{"id": "a" * 32, "name": "Ada", "created_at": "2020-01-01T00:00:00.000Z"}]
    )
    row = execute_sql(db, "SELECT id, created_at FROM people")[0]
    assert row["id"] == "a" * 32
    assert row["created_at"] == "2020-01-01T00:00:00.000Z"


def test_dump_sql_roundtrips_schema_and_data(db):
    _mk_people(db, ["Ada"])
    text = dump_sql(db)
    assert "CREATE TABLE" in text and "Ada" in text


# --- change detection (drives `life watch`) ---------------------------------


def test_db_version_changes_after_a_write(db):
    before = db_version(db)
    _mk_people(db, ["Ada"])
    assert db_version(db) != before


def test_db_changed_reports_once_per_change(db):
    _mk_people(db, ["Ada"])
    state = db_version(db)
    changed, state = db_changed(db, state)
    assert changed is False
    execute_sql(db, "UPDATE people SET name = 'Grace'")
    changed, state = db_changed(db, state)
    assert changed is True
    changed, _ = db_changed(db, state)
    assert changed is False


def test_watch_survives_check_failure_but_logs_it(db, hub, monkeypatch, capsys):
    def boom(path, as_of=None):
        raise sqlite3.OperationalError("boom")

    monkeypatch.setattr("life_data.catalog.check", boom)
    monkeypatch.setattr("life_data.db_changed", lambda path, previous: (True, previous))
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)  # must not raise
    assert "check failed" in capsys.readouterr().err


def test_watch_survives_any_check_error(db, hub, monkeypatch, capsys):
    """A hard-deleted derived row used to raise TypeError, which the old
    guard did not catch, and the watch daemon died."""

    def boom(path, as_of=None):
        raise TypeError("'NoneType' object is not subscriptable")

    monkeypatch.setattr("life_data.catalog.check", boom)
    monkeypatch.setattr("life_data.db_changed", lambda path, previous: (True, previous))
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)  # must not raise
    assert "check failed" in capsys.readouterr().err


def test_watch_prints_check_findings_to_stderr(db, hub, monkeypatch, capsys):
    monkeypatch.setattr("life_data.catalog.check", lambda path, as_of=None: [{"rule": "options"}])
    monkeypatch.setattr("life_data.db_changed", lambda path, previous: (True, previous))
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)
    assert json.loads(capsys.readouterr().err)["check"] == [{"rule": "options"}]


# --- sync engine (LocalHub) --------------------------------------------------


def test_sync_pushes_schema_and_rows_to_hub(db, hub):
    _mk_people(db, ["Ada", "Grace"])
    stats = sync(db, hub)
    # 2 people rows + 1 catalog_properties row + 1 catalog_log row for the
    # "name" column that create_table catalogs on the way in
    assert stats["pushed"] == 4
    assert {r["name"] for r in hub.rows_pull("people", ["name"], "")} == {"Ada", "Grace"}


def test_second_sync_is_noop(db, hub):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    assert sync(db, hub) == {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}
    assert sync(db, hub) == {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}


def test_pull_cursor_does_not_skip_rows_written_during_the_pull(db, hub):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    real_pull = hub.rows_pull

    def pull_then_hub_writes(table, columns, since):
        rows = real_pull(table, columns, since)
        if table == "people":  # a hub-side derivation lands after the pull query
            time.sleep(0.002)
            with connect(hub.path) as conn:  # the hub stamps hub_at on its own writes
                conn.execute(
                    f"INSERT INTO people (id, name, hub_at) VALUES ('derived', 'Hub Derived', {NOW})"
                )
        return rows

    hub.rows_pull = pull_then_hub_writes
    sync(db, hub)
    hub.rows_pull = real_pull
    assert sync(db, hub)["pulled"] == 1
    assert (
        execute_sql(db, "SELECT name FROM people WHERE id = 'derived'")[0]["name"] == "Hub Derived"
    )


def test_pull_cursor_does_not_skip_a_replica_pushing_an_older_stamp(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'B edit'")  # stamped t1, still local to B
    time.sleep(0.002)
    insert_rows(db, "people", [{"name": "Grace"}])  # A's own row, stamped after t1
    real_pull = hub.rows_pull
    fired = []

    def pull_then_b_pushes(table, columns, since):
        rows = real_pull(table, columns, since)
        if table == "people" and not fired:
            fired.append(table)
            sync(other, hub)  # B's t1 edit reaches the hub after A's pull query
        return rows

    hub.rows_pull = pull_then_b_pushes
    sync(db, hub)  # ... and A pushes its newer row in this same sync
    hub.rows_pull = real_pull
    sync(db, hub)
    assert {r["name"] for r in execute_sql(db, "SELECT name FROM people")} == {"B edit", "Grace"}


def test_late_push_with_old_stamp_is_pulled_by_other_replicas(db, hub, tmp_path):
    """The pull cursor is the HUB's arrival time, not a client stamp: a replica
    that pushes late with an old `updated_at` still reaches everyone else."""
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'B edit'")  # stamped t1, offline
    time.sleep(0.002)
    insert_rows(db, "people", [{"name": "Grace"}])  # A's own row, newer than t1
    sync(db, hub)
    sync(db, hub)  # A's cursor is now past B's t1 stamp
    sync(other, hub)  # B finally pushes: the hub stamps its arrival NOW
    sync(db, hub)
    assert {r["name"] for r in execute_sql(db, "SELECT name FROM people")} == {"B edit", "Grace"}


def test_hub_at_is_assigned_by_hub_not_client(db, hub):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    with connect(hub.path) as conn:
        stamped = conn.execute("SELECT hub_at FROM people").fetchone()["hub_at"]
    assert stamped and stamped > "2"
    out = hub.rows_push(
        "people",
        ["id", "name", "updated_at", "hub_at"],
        [{"id": "x", "name": "Faked", "updated_at": "2099-01-01T00:00:00.000Z", "hub_at": "1970"}],
    )
    with connect(hub.path) as conn:
        row = conn.execute("SELECT hub_at FROM people WHERE id = 'x'").fetchone()
    assert row["hub_at"] == out["hub_at"] != "1970"


def test_ensure_hub_at_backfills_existing_tables_and_forces_one_full_pull(db, hub, tmp_path):
    from life_data import ensure_hub_at

    _mk_people(db, ["Ada"])
    # a replica upgraded from before hub_at existed: drop the column back off
    with connect(db) as conn:
        conn.execute("ALTER TABLE people DROP COLUMN hub_at")
    assert "hub_at" not in {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert ensure_hub_at(db) is True
    assert "hub_at" in {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert ensure_hub_at(db) is False  # idempotent
    assert sync(db, hub)["pushed"] >= 1


def test_upgrade_from_a_pre_hub_at_estate_converges(db, hub, tmp_path):
    """The one-time migration: an existing replica and hub whose tables predate
    hub_at, with a last_pull holding an updated_at-shaped stamp."""
    _mk_people(db, ["Ada"])
    sync(db, hub)
    for path in (db, hub.path):  # rewind both sides to the pre-hub_at shape
        with connect(path) as conn:
            for t in [
                r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ]:
                if not t.startswith(("_", "sqlite_")):
                    conn.execute(f'ALTER TABLE "{t}" DROP COLUMN hub_at')
    stale = execute_sql(db, "SELECT max(updated_at) AS m FROM people")[0]["m"]
    execute_sql(db, f"UPDATE _sync_state SET value = '{stale}' WHERE key = 'last_pull'")

    stats = sync(db, hub)  # the ALTERs replay to the hub in this same sync
    assert stats["ddl_applied"] >= 1
    assert execute_sql(db, "SELECT hub_at FROM people")  # column is back
    with connect(hub.path) as conn:
        assert conn.execute("SELECT hub_at FROM people").fetchone()["hub_at"]

    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    assert {r["name"] for r in execute_sql(other, "SELECT name FROM people")} == {"Ada"}
    assert sync(db, hub) == {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}


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
    from life_data.catalog import inputs_hash, set_property, value_hash

    create_table(db, "movies", ["title:text", "slug:text"])
    set_property(db, "movies", "slug", type="text", derived_by="http:slug", inputs=["title"])
    insert_rows(db, "movies", [{"id": "m1", "title": "A"}])
    # the hub's derive engine wrote the value and its provenance; stand in for it
    with connect(db) as conn:
        conn.execute("UPDATE movies SET slug = 'a' WHERE id = 'm1'")
        conn.execute(
            "INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash) "
            "VALUES ('movies:m1:slug', 'movies', 'm1', 'slug', 'http:slug', ?, ?)",
            (
                inputs_hash(conn, "movies", "m1", ["title"]),
                value_hash(conn, "movies", "m1", "slug"),
            ),
        )
    sync(db, hub)
    c = sqlite3.connect(db)
    c.execute("UPDATE movies SET slug = 'hand' WHERE id = 'm1'")
    c.commit()
    c.close()
    time.sleep(0.002)
    stats = sync(db, hub)
    assert stats["rejected"][0]["rule"] == "provenance"
    assert hub.rows_pull("movies", ["slug"], "")[0]["slug"] == "a"


def test_sync_pushes_catalog_and_provenance_before_data(db, hub, monkeypatch):
    from life_data import _user_tables
    from life_data.catalog import ensure_catalog

    _mk_people(db, ["Ada"])
    ensure_catalog(db)
    order = _user_tables(db)
    assert order.index("provenance") < order.index("people")
    assert order.index("catalog_properties") < order.index("people")


def test_fresh_replica_pulls_schema_and_rows_without_echoing(db, hub, tmp_path):
    _mk_people(db, ["Ada", "Grace"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    stats = sync(other, hub)
    assert stats["ddl_applied"] >= 1 and stats["pulled"] == 4 and stats["pushed"] == 0
    assert {r["name"] for r in execute_sql(other, "SELECT name FROM people")} == {"Ada", "Grace"}


def test_lww_newer_edit_wins(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'Ada Lovelace'")
    time.sleep(0.002)
    execute_sql(db, "UPDATE people SET name = 'Countess Ada'")  # newer
    sync(other, hub)
    sync(db, hub)
    sync(other, hub)
    assert execute_sql(db, "SELECT name FROM people")[0]["name"] == "Countess Ada"
    assert execute_sql(other, "SELECT name FROM people")[0]["name"] == "Countess Ada"


def test_soft_delete_propagates(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(db, "UPDATE people SET deleted_at = updated_at")
    sync(db, hub)
    sync(other, hub)
    assert execute_sql(other, "SELECT deleted_at FROM people")[0]["deleted_at"] is not None


def test_added_column_replays_to_other_replica(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(db, "ALTER TABLE people ADD COLUMN nickname TEXT")
    sync(db, hub)
    sync(other, hub)
    cols = {r["name"] for r in execute_sql(other, "PRAGMA table_info(people)")}
    assert "nickname" in cols


# --- HTTP hub (wire format against a real socket) ---------------------------


class _Handler(BaseHTTPRequestHandler):
    hub = None
    token = "testtoken"
    last_user_agent = None
    streams: ClassVar[dict] = {}
    batches: ClassVar[dict] = {}
    derive_calls: ClassVar[list] = []
    derive_fail_id = None

    def log_message(self, *a):
        pass

    def _deny(self):
        denied = b'{"error":"forbidden"}'
        self.send_response(403)
        self.send_header("Content-Length", str(len(denied)))
        self.end_headers()
        self.wfile.write(denied)

    def _json(self, obj):
        payload = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.headers.get("Authorization") != f"Bearer {self.token}":
            self._deny()
            return
        parts = self.path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["v1", "streams"] and parts[3] == "tail":
            records = _Handler.streams.get(parts[2], [])
            self._json(json.loads(records[-1]) if records else None)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))  # always drain the request
        _Handler.last_user_agent = self.headers.get("User-Agent")
        if self.headers.get("Authorization") != f"Bearer {self.token}":
            self._deny()
            return
        parts = self.path.strip("/").split("/")
        if parts[:2] == ["v1", "tokens"]:
            body = json.loads(raw or "{}")
        if parts == ["v1", "tokens", "create"]:
            _Handler.tokens = getattr(_Handler, "tokens", {})
            _Handler.tokens[body["name"]] = body["scopes"]
            self._json({"name": body["name"], "token": "lt_" + "x" * 40, "scopes": body["scopes"]})
            return
        if parts == ["v1", "tokens", "revoke"]:
            _Handler.tokens.pop(body["name"], None)
            self._json({"revoked": body["name"]})
            return
        if parts == ["v1", "tokens", "list"]:
            self._json(
                [{"name": n, "scopes": s} for n, s in getattr(_Handler, "tokens", {}).items()]
            )
            return
        if parts == ["v1", "archive", "query"]:
            self._json({"result": {"rows": [{"stream": "location", "n": 4}]}})
            return
        if len(parts) == 4 and parts[:2] == ["v1", "streams"] and parts[3] == "batch":
            records = json.loads(raw)
            _Handler.batches.setdefault(parts[2], []).append(records)
            self._json({"count": len(records), "key": "landing/x-batch.json"})
            return
        if len(parts) == 4 and parts[:2] == ["v1", "streams"] and parts[3] == "append":
            _Handler.streams.setdefault(parts[2], []).append(raw.decode())
            self._json({"key": f"landing/{parts[2]}/test.json"})
            return
        if parts == ["v1", "derive"]:
            body = json.loads(raw or "{}")
            _Handler.derive_calls.append(body)
            ids = body["ids"]
            failed = []
            if _Handler.derive_fail_id in ids:
                failed = [{"id": _Handler.derive_fail_id, "col": body.get("col"), "error": "boom"}]
            self._json({"derived": len(ids) - len(failed), "failed": failed})
            return
        body = json.loads(raw or "{}")
        h = self.hub
        if self.path == "/v1/schema/pull":
            out = {"entries": h.schema_pull()}
        elif self.path == "/v1/schema/push":
            out = {"applied": h.schema_push(body["entries"])}
        elif self.path == "/v1/rows/pull":
            out = {"rows": h.rows_pull(body["table"], body["columns"], body["since"])}
        elif self.path == "/v1/rows/push":
            out = h.rows_push(body["table"], body["columns"], body["rows"])
        elif self.path == "/v1/cursor":
            out = {"max_hub_at": h.cursor(body["tables"])}
        else:
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _serve(hub_db):
    backing = LocalHub(hub_db)
    backing.ensure_ready()
    _Handler.hub = backing
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture()
def http_hub(tmp_path):
    server = _serve(tmp_path / "server.db")
    yield HttpHub(f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer testtoken"})
    server.shutdown()


def test_sync_works_end_to_end_over_http(db, http_hub, tmp_path):
    _mk_people(db, ["Ada", "Grace"])
    assert sync(db, http_hub)["pushed"] == 4
    other = init(tmp_path / "other" / "life.db")
    assert sync(other, http_hub)["pulled"] == 4
    assert {r["name"] for r in execute_sql(other, "SELECT name FROM people")} == {"Ada", "Grace"}


def test_http_hub_rejects_bad_credentials(db, tmp_path):
    server = _serve(tmp_path / "server2.db")
    bad = HttpHub(f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer wrong"})
    _mk_people(db, ["Ada"])
    with pytest.raises(RuntimeError, match="403"):
        sync(db, bad)
    server.shutdown()


# --- CLI ---------------------------------------------------------------------


def test_cli_init_table_insert_sql_roundtrip(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    assert main(["init"]) == 0
    assert main(["table", "create", "pets", "name:text"]) == 0
    monkeypatch.setattr("sys.stdin", io.StringIO('[{"name": "Rex"}]'))
    assert main(["insert", "pets"]) == 0
    capsys.readouterr()
    assert main(["sql", "SELECT name FROM pets"]) == 0
    assert json.loads(capsys.readouterr().out) == [{"name": "Rex"}]


def test_cli_path_prints_db_path(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    assert main(["path"]) == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "life.db")


def test_cli_export_writes_sql_to_stdout(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    main(["init"])
    main(["table", "create", "pets", "name:text"])
    capsys.readouterr()
    assert main(["export"]) == 0
    assert 'CREATE TABLE "pets"' in capsys.readouterr().out


def test_http_hub_default_timeout_covers_slow_stream_tees():
    """The hub's pipeline tee can stall past 30s; a short client timeout makes
    a fully-successful batch look failed and invites duplicating retries."""
    hub = HttpHub("http://127.0.0.1:1")
    assert hub.timeout >= 120


def test_http_hub_sends_a_real_user_agent(db, http_hub):
    """Cloudflare's edge bot-protection 403s the default Python-urllib agent."""
    _mk_people(db, ["Ada"])
    sync(db, http_hub)
    assert _Handler.last_user_agent.startswith("life-data/")


# --- streams & archive -------------------------------------------------------


def test_expand_stream_sql_unions_parquet_and_landing():
    from life_data import expand_stream_sql

    manifest = {
        "parquet": ["https://hub/v1/archive/parquet/location/year%3D2026/part-0.parquet"],
        "landing": ["https://hub/v1/archive/landing/location/a.json"],
    }
    sql = expand_stream_sql("SELECT count(*) FROM stream('location')", {"location": manifest})
    assert "read_parquet" in sql and "read_json" in sql and "UNION ALL BY NAME" in sql
    assert "stream(" not in sql


def test_expand_stream_sql_parquet_only():
    from life_data import expand_stream_sql

    manifest = {"parquet": ["https://hub/p.parquet"], "landing": []}
    sql = expand_stream_sql("SELECT * FROM stream('location')", {"location": manifest})
    assert "read_parquet" in sql and "read_json" not in sql


def test_expand_stream_sql_empty_stream_raises():
    from life_data import expand_stream_sql

    with pytest.raises(RuntimeError, match="empty"):
        expand_stream_sql("SELECT * FROM stream('x')", {"x": {"parquet": [], "landing": []}})


def test_cli_stream_append_posts_body_and_tail_reads_back(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server3.db")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "testtoken")
    monkeypatch.setattr("sys.stdin", io.StringIO('{"lat": 42.36, "lon": -71.09}'))
    assert main(["stream", "append", "location"]) == 0
    capsys.readouterr()
    assert main(["stream", "tail", "location"]) == 0
    assert json.loads(capsys.readouterr().out) == {"lat": 42.36, "lon": -71.09}
    server.shutdown()


def test_cli_archive_query_proxies_sql_through_hub(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server4.db")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "testtoken")
    assert main(["archive", "query", "SELECT count(*) AS n FROM life.events"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["result"]["rows"][0]["n"] == 4
    server.shutdown()


# --- scoped tokens -----------------------------------------------------------


def test_cli_token_create_list_revoke(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server5.db")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "testtoken")
    assert main(["token", "create", "phone", "--scopes", "streams:append"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["name"] == "phone" and out["token"].startswith("lt_")
    assert main(["token", "list"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed[0]["name"] == "phone" and listed[0]["scopes"] == "streams:append"
    assert main(["token", "revoke", "phone"]) == 0
    assert json.loads(capsys.readouterr().out)["revoked"] == "phone"
    server.shutdown()


def test_cli_stream_import_batches_ndjson(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server6.db")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "testtoken")
    ndjson = "\n".join(json.dumps({"n": i}) for i in range(1205))
    monkeypatch.setattr("sys.stdin", io.StringIO(ndjson))
    assert main(["stream", "import", "history"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["imported"] == 1205
    assert len(_Handler.batches["history"]) == 3  # 500-record chunks
    assert sum(len(b) for b in _Handler.batches["history"]) == 1205


# --- derive --------------------------------------------------------------


def test_cli_derive_chunks_by_50_and_reports_totals(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server7.db")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "testtoken")
    _Handler.derive_calls = []
    _Handler.derive_fail_id = None
    main(["init"])
    main(["table", "create", "movies", "title:text", "status:text"])
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(json.dumps([{"title": f"m{i}", "status": "x"} for i in range(120)])),
    )
    main(["insert", "movies"])
    capsys.readouterr()
    assert main(["derive", "movies.title", "--where", "status = 'x'"]) == 0
    assert json.loads(capsys.readouterr().out) == {"derived": 120, "failed": []}
    assert [len(c["ids"]) for c in _Handler.derive_calls] == [50, 50, 20]
    assert all(c["table"] == "movies" and c["col"] == "title" for c in _Handler.derive_calls)
    server.shutdown()


def test_cli_derive_reports_failures_and_exits_1(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server8.db")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "testtoken")
    _Handler.derive_calls = []
    _Handler.derive_fail_id = "m2"
    main(["init"])
    main(["table", "create", "movies", "title:text", "status:text"])
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(
            json.dumps([{"id": f"m{i}", "title": f"m{i}", "status": "x"} for i in range(3)])
        ),
    )
    main(["insert", "movies"])
    capsys.readouterr()
    assert main(["derive", "movies.title", "--where", "status = 'x'"]) == 1
    out = json.loads(capsys.readouterr().out)
    assert out["derived"] == 2
    assert out["failed"] == [{"id": "m2", "col": "title", "error": "boom"}]
    server.shutdown()


def test_cli_derive_without_hub_token_fails_clearly(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    monkeypatch.delenv("LIFE_HUB_URL", raising=False)
    main(["init"])
    main(["table", "create", "movies", "title:text"])
    capsys.readouterr()
    assert main(["derive", "movies.title"]) == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert "token" in err.lower()
    assert execute_sql(tmp_path / "life.db", "SELECT count(*) AS n FROM movies")[0]["n"] == 0


# --- quoted identifiers ------------------------------------------------------


def test_qi_quotes_and_rejects_unsafe_identifiers():
    from life_data import qi

    assert qi("cast") == '"cast"'
    for bad in ("", "1col", "a-b", "x; DROP TABLE y", 'a"b'):
        with pytest.raises(ValueError):
            qi(bad)


def test_reserved_word_columns_round_trip_through_sync(db, hub, tmp_path):
    create_table(db, "movies", ["cast:text", "order:int", "group:text", "select:text"])
    insert_rows(db, "movies", [{"cast": "Ada", "order": 1, "group": "g", "select": "s"}])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    assert sync(other, hub)["pulled"] >= 1
    row = execute_sql(other, 'SELECT "cast", "order", "group", "select" FROM movies')[0]
    assert row == {"cast": "Ada", "order": 1, "group": "g", "select": "s"}
    assert catalog.check(other) == []
