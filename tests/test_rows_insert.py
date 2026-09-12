"""Atomic creation uses isolated stores; no credentials or live hub access."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

import life_data as life

T0 = "2025-01-01T00:00:00.000Z"
T1 = "2025-01-02T00:00:00.000Z"


@pytest.fixture
def hub(tmp_path):
    hub = life.LocalHub(life.init(tmp_path / "hub.db"))
    life.create_table(hub.path, "items", ["name:text!", "status:select(saved|new)", "qty:int"])
    return hub


def insert(hub, rows, **kwargs):
    return hub.rows_insert("items", list(dict.fromkeys(k for r in rows for k in r)), rows, **kwargs)


def stored(hub):
    return life.execute_sql(hub.path, "SELECT * FROM items ORDER BY id")


@pytest.mark.parametrize("deleted", [None, T0])
@pytest.mark.parametrize("stamp", [None, "invalid", "2099-01-01T00:00:00.000Z"])
def test_existing_ids_ignore_initializer_content_and_preserve_all_state(hub, deleted, stamp):
    life.insert_rows(
        hub.path,
        "items",
        [
            {
                "id": "kept",
                "name": "saved",
                "status": "saved",
                "deleted_at": deleted,
                "updated_at": T0,
            }
        ],
    )
    before = stored(hub)
    history = life.execute_sql(hub.path, "SELECT * FROM history")
    out = insert(
        hub,
        [
            {
                "id": "kept",
                "name": None,
                "status": {"invalid": True},
                "updated_at": stamp,
                "deleted_at": None,
                "hub_at": "forged",
            }
        ],
    )
    assert out == {"inserted": [], "existing": ["kept"], "rejected": []}
    assert stored(hub) == before
    assert life.execute_sql(hub.path, "SELECT * FROM history") == history


def test_new_rows_validate_and_replay_reports_existing(hub):
    rows = [
        {"id": "new", "name": "value", "status": "new", "updated_at": T0},
        {"id": "invalid", "name": None, "updated_at": T0},
        {"id": "unstamped", "name": "value"},
    ]
    out = insert(hub, rows)
    assert out["inserted"] == ["new"]
    assert out["existing"] == []
    assert {r["id"] for r in out["rejected"]} == {"invalid", "unstamped"}
    assert [r["id"] for r in stored(hub)] == ["new"]
    before = stored(hub)
    assert insert(hub, rows)["existing"] == ["new"]
    assert stored(hub) == before
    assert life.execute_sql(hub.path, "SELECT * FROM history") == []
    assert before[0]["hub_at"] and before[0]["hub_at"] != T0


def test_sql_defaults_are_validated_as_stored(hub):
    life.execute_sql(
        hub.path,
        "CREATE TABLE defaults (id TEXT PRIMARY KEY, name TEXT DEFAULT 'default', qty INTEGER DEFAULT 4, updated_at TEXT, deleted_at TEXT, hub_at TEXT)",
    )
    life.catalog.set_property(hub.path, "defaults", "name", type="text", required=1)
    rows = [{"id": "a", "updated_at": T0}, {"id": "b", "updated_at": T0, "name": None}]
    out = hub.rows_insert("defaults", ["id", "name", "updated_at"], rows)
    assert out["inserted"] == ["a"]
    assert out["rejected"][0]["id"] == "b"
    assert life.execute_sql(hub.path, "SELECT id,name,qty FROM defaults") == [
        {"id": "a", "name": "default", "qty": 4}
    ]


@pytest.mark.parametrize("problem", ["duplicate", "history", "missing-id", "unlisted-id"])
def test_invalid_requests_fail_before_any_mutation(hub, problem):
    rows = [{"id": "a", "name": "value", "updated_at": T0}]
    columns = list(rows[0])
    kwargs = {}
    if problem == "duplicate":
        rows.append({**rows[0], "name": "second"})
    elif problem == "history":
        kwargs["history"] = []
    elif problem == "missing-id":
        rows.append({"name": "value"})
    else:
        columns.remove("id")
    before = life.dump_sql(hub.path)
    with pytest.raises(ValueError):
        hub.rows_insert("items", columns, rows, **kwargs)
    assert life.dump_sql(hub.path) == before


def test_invariant_rejection_rolls_back_only_invalid_row(hub):
    life.catalog.set_rule(
        hub.path,
        "positive",
        tbl="items",
        kind="invariant",
        enforce=1,
        text="positive quantity",
        sql="SELECT id FROM changed WHERE qty < 0",
    )
    out = insert(
        hub,
        [
            {"id": "good", "name": "value", "qty": 1, "updated_at": T0},
            {"id": "bad", "name": "value", "qty": -1, "updated_at": T0},
        ],
    )
    assert out["inserted"] == ["good"]
    assert out["rejected"][0]["rule"] == "positive"
    assert [r["id"] for r in stored(hub)] == ["good"]
    assert life.execute_sql(hub.path, "SELECT * FROM history") == []


def test_unexpected_constraint_failure_rolls_back_all_values_and_receipts(hub):
    life.execute_sql(hub.path, "CREATE UNIQUE INDEX unique_name ON items(name)")
    before = stored(hub)
    with pytest.raises(sqlite3.IntegrityError):
        insert(
            hub,
            [
                {"id": "a", "name": "same", "updated_at": T0},
                {"id": "b", "name": "same", "updated_at": T0},
            ],
        )
    assert stored(hub) == before
    assert life.execute_sql(hub.path, "SELECT * FROM history") == []


@pytest.mark.parametrize("deleted", [None, T0])
def test_competing_insert_commits_before_waiting_creator_without_overwrite(
    hub, monkeypatch, deleted
):
    connect = life.connect
    waiting = threading.Event()

    def traced(path, manual_tx=False):
        conn = connect(path, manual_tx)
        conn.set_trace_callback(lambda sql: waiting.set() if sql == "BEGIN IMMEDIATE" else None)
        return conn

    with connect(hub.path) as winner, ThreadPoolExecutor(max_workers=1) as pool:
        winner.execute("BEGIN IMMEDIATE")
        winner.execute(
            "INSERT INTO items(id,name,status,deleted_at,updated_at) VALUES ('race','saved','saved',?,?)",
            (deleted, T0),
        )
        with monkeypatch.context() as m:
            m.setattr(life, "connect", traced)
            future = pool.submit(
                insert,
                hub,
                [{"id": "race", "name": "initializer", "status": "new", "updated_at": T1}],
            )
            try:
                assert waiting.wait(5)
                assert not future.done()
            finally:
                winner.commit()
            assert future.result(timeout=5) == {
                "inserted": [],
                "existing": ["race"],
                "rejected": [],
            }
    row = stored(hub)[0]
    assert (row["name"], row["status"], row["deleted_at"], row["updated_at"]) == (
        "saved",
        "saved",
        deleted,
        T0,
    )
    assert life.execute_sql(hub.path, "SELECT * FROM history") == []


def test_http_uses_distinct_route_and_preserves_receipts_across_chunks(hub, monkeypatch):
    client = life.HttpHub("https://hub.example")
    calls = []

    def post(route, body):
        calls.append((route, len(body["rows"])))
        return hub.rows_insert(body["table"], body["columns"], body["rows"])

    monkeypatch.setattr(client, "_post", post)
    rows = [{"id": f"row-{i}", "name": "value", "updated_at": T0} for i in range(417)]
    out = insert(client, rows)
    assert set(out["inserted"]) == {r["id"] for r in rows}
    assert out["existing"] == out["rejected"] == []
    assert calls == [("/v1/rows/insert", 200), ("/v1/rows/insert", 200), ("/v1/rows/insert", 17)]
    assert set(insert(client, rows)["existing"]) == set(out["inserted"])


def test_http_rejects_cross_chunk_duplicates_and_history_before_network(monkeypatch):
    client = life.HttpHub("https://hub.example")
    monkeypatch.setattr(client, "_post", lambda *_: pytest.fail("invalid request reached network"))
    rows = [{"id": str(i), "name": "value", "updated_at": T0} for i in range(201)]
    with pytest.raises(ValueError):
        insert(client, [*rows, rows[0]])
    with pytest.raises(ValueError):
        insert(client, rows, history=[])


@pytest.mark.parametrize(
    "response",
    [
        {"upserted": 1, "rejected": []},
        {"inserted": ["a"], "existing": ["a"], "rejected": []},
        {"inserted": ["other"], "existing": [], "rejected": []},
        {"inserted": [], "existing": [], "rejected": []},
        {"inserted": ["a"], "existing": [], "rejected": [{"id": "a"}]},
        None,
    ],
)
def test_http_rejects_ambiguous_or_invalid_receipts(monkeypatch, response):
    client = life.HttpHub("https://hub.example")
    monkeypatch.setattr(client, "_post", lambda *_: response)
    with pytest.raises(RuntimeError, match="insert response"):
        insert(client, [{"id": "a", "name": "value", "updated_at": T0}])


def test_http_never_falls_back_on_unsupported_hub(monkeypatch):
    client = life.HttpHub("https://hub.example")
    calls = []

    def unsupported(route, body):
        calls.append(route)
        raise RuntimeError("hub HTTP 404")

    monkeypatch.setattr(client, "_post", unsupported)
    with pytest.raises(RuntimeError, match="404"):
        insert(client, [{"id": "a", "name": "value", "updated_at": T0}])
    assert calls == ["/v1/rows/insert"]


@pytest.mark.parametrize(
    "values, rule", [({"status": "invalid"}, "options"), ({"qty": "invalid"}, "type")]
)
def test_new_content_obeys_catalog_types_and_options(hub, values, rule):
    out = insert(hub, [{"id": "bad", "name": "value", "updated_at": T0, **values}])
    assert out["inserted"] == out["existing"] == []
    assert out["rejected"][0]["rule"] == rule
    assert stored(hub) == []
    assert life.execute_sql(hub.path, "SELECT * FROM history") == []


def test_suppressed_insert_requires_real_receipt(hub):
    life.execute_sql(
        hub.path,
        "CREATE TRIGGER ignore_insert BEFORE INSERT ON items WHEN NEW.id='ignored' BEGIN SELECT RAISE(IGNORE); END",
    )
    out = insert(
        hub,
        [
            {"id": "good", "name": "value", "updated_at": T0},
            {"id": "ignored", "name": "value", "updated_at": T0},
        ],
    )
    assert out["inserted"] == ["good"]
    assert out["existing"] == []
    assert out["rejected"][0]["id"] == "ignored"
    assert out["rejected"][0]["retryable"] is True
    assert [r["id"] for r in stored(hub)] == ["good"]
    assert life.execute_sql(hub.path, "SELECT * FROM history") == []


def test_existing_provenance_keeps_original_creation_detail(hub):
    with life.connect(hub.path) as conn:
        conn.execute(
            "INSERT INTO provenance(id,detail,updated_at) VALUES ('edge',?,?)",
            ('{"created_row":0}', T0),
        )
    before = life.execute_sql(hub.path, "SELECT * FROM provenance")
    row = {"id": "edge", "detail": '{"created_row":1}', "updated_at": T1}
    assert hub.rows_insert("provenance", list(row), [row]) == {
        "inserted": [],
        "existing": ["edge"],
        "rejected": [],
    }
    assert life.execute_sql(hub.path, "SELECT * FROM provenance") == before


def test_insert_round_trip_over_loopback_http(hub):
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    paths = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            paths.append(self.path)
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            result = hub.rows_insert(data["table"], data["columns"], data["rows"])
            payload = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = life.HttpHub(f"http://127.0.0.1:{server.server_port}")
        row = {"id": "a", "name": "value", "updated_at": T0}
        assert insert(client, [row]) == {"inserted": ["a"], "existing": [], "rejected": []}
        assert insert(client, [row]) == {"inserted": [], "existing": ["a"], "rejected": []}
        assert paths == ["/v1/rows/insert", "/v1/rows/insert"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
