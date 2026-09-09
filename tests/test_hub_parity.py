"""Hub boundary regressions using only isolated, synthetic stores."""

import pytest

from life_data import LocalHub, catalog, connect, create_table, execute_sql, init, sync

T0 = "2025-01-01T00:00:00.000Z"
T1 = "2025-01-02T00:00:00.000Z"
T2 = "2025-01-03T00:00:00.000Z"


@pytest.fixture
def hub(tmp_path):
    h = LocalHub(init(tmp_path / "hub.db"))
    create_table(h.path, "items", ["name:text!", "qty:int"])
    return h


def push(hub, rows, table="items"):
    return hub.rows_push(table, list(dict.fromkeys(k for r in rows for k in r)), rows)


@pytest.mark.parametrize(
    "stamp",
    [
        "",
        "tomorrow",
        "2025-02-29T00:00:00.000Z",
        "2025-01-01T24:00:00.000Z",
        "2025-01-01T00:00:00Z",
        "2025-01-01T00:00:00.000+00:00",
        123,
        None,
    ],
)
def test_protocol_timestamp_without_catalog(hub, stamp):
    with connect(hub.path) as c:
        c.execute("CREATE TABLE raw (id TEXT PRIMARY KEY, updated_at TEXT)")
    out = push(hub, [{"id": "a", "updated_at": stamp}], "raw")
    assert out["upserted"] == 0
    assert out["rejected"][0]["col"] == "updated_at"
    assert execute_sql(hub.path, "SELECT * FROM raw") == []


def test_duplicate_ids_validate_evolving_state(hub):
    out = push(
        hub, [{"id": "a", "name": "A", "updated_at": T0}, {"id": "a", "qty": 2, "updated_at": T1}]
    )
    assert out["rejected"] == []
    assert execute_sql(hub.path, "SELECT name, qty FROM items") == [{"name": "A", "qty": 2}]


def test_invariant_rollback_history_and_mixed_rows(hub):
    push(hub, [{"id": "a", "name": "A", "qty": 2, "updated_at": T0}])
    catalog.set_rule(
        hub.path,
        "nondecreasing",
        kind="invariant",
        tbl="items",
        enforce=1,
        text="quantity cannot decrease",
        sql="SELECT c.id FROM changed c JOIN before b USING(id) WHERE c.qty < b.qty",
    )
    out = push(
        hub,
        [
            {"id": "a", "qty": 1, "updated_at": T1},
            {"id": "b", "name": "B", "qty": 3, "updated_at": T1},
        ],
    )
    assert out["upserted"] == 1
    assert out["rejected"][0]["rule"] == "nondecreasing"
    assert execute_sql(hub.path, "SELECT qty FROM items WHERE id='a'")[0]["qty"] == 2
    assert execute_sql(hub.path, "SELECT * FROM history") == []
    assert not push(hub, [{"id": "a", "qty": 4, "updated_at": T2}])["rejected"]
    assert execute_sql(hub.path, "SELECT col, old, new FROM history") == [
        {"col": "qty", "old": "2", "new": "4"}
    ]
    push(hub, [{"id": "a", "qty": 1, "updated_at": T0}])
    push(hub, [{"id": "a", "qty": 4, "updated_at": T2}])
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == 1


@pytest.mark.parametrize("table", ["changed", "before", "now"])
def test_context_names_preserve_user_tables(hub, table):
    create_table(hub.path, table, ["name:text"])
    catalog.set_rule(
        hub.path,
        "context",
        kind="invariant",
        tbl=table,
        enforce=1,
        text="bad name",
        sql="SELECT id FROM changed WHERE name = 'bad' AND (SELECT ts FROM now) IS NOT NULL",
    )
    out = push(hub, [{"id": "a", "name": "bad", "updated_at": T0}], table)
    assert out["rejected"][0]["rule"] == "context"
    assert execute_sql(hub.path, f'SELECT * FROM "{table}"') == []


def test_replica_history_does_not_double_log(hub, tmp_path):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "qty": 2, "updated_at": T0}])
    sync(replica, hub)
    execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
    original = execute_sql(replica, "SELECT id FROM history")
    assert len(original) == 1
    sync(replica, hub)
    sync(replica, hub)
    assert execute_sql(hub.path, "SELECT id FROM history") == original
    assert execute_sql(replica, "SELECT id FROM history") == original


def event(id, old, new, stamp=T1):
    return {
        "id": id,
        "tbl": "items",
        "row_id": "a",
        "col": "name",
        "old": old,
        "new": new,
        "origin": "replica",
        "created_at": stamp,
        "updated_at": stamp,
    }


@pytest.mark.parametrize(
    ("old", "new", "events", "extra"),
    [
        ("A", "C", [event("e1", "A", "B"), event("e2", "B", "C")], []),
        ("A", "A", [event("e1", "A", "B"), event("e2", "B", "A")], []),
        ("D", "C", [event("e1", "A", "B"), event("e2", "B", "C")], [("D", "C")]),
        (None, "C", [event("e1", "A", "B"), event("e2", "B", "C")], []),
    ],
)
def test_attached_history_keeps_original_events_and_only_logs_real_hub_transition(
    hub, old, new, events, extra
):
    if old is not None:
        push(hub, [{"id": "a", "name": old, "updated_at": T0}])
    row = {"id": "a", "name": new, "updated_at": T2}
    out = hub.rows_push("items", list(row), [row], history=events)
    assert out["rejected"] == []
    records = execute_sql(hub.path, "SELECT id, old, new, origin FROM history")
    assert {r["id"] for r in records if r["origin"] == "replica"} == {"e1", "e2"}
    assert [(r["old"], r["new"]) for r in records if r["origin"] == "hub:reconcile"] == extra
    assert len(records) == len(events) + len(extra)
    hub.rows_push("items", list(row), [row], history=events)
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == len(records)


def test_stale_payload_can_replicate_original_history_without_hub_edits(hub):
    push(hub, [{"id": "a", "name": "D", "updated_at": T2}])
    row = {"id": "a", "name": "B", "updated_at": T1}
    assert not hub.rows_push("items", list(row), [row], history=[event("e1", "A", "B")])["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "D"}]
    assert execute_sql(hub.path, "SELECT id FROM history") == [{"id": "e1"}]


def test_rejected_sync_preserves_push_cursor_and_attached_history(hub, tmp_path):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    sync(replica, hub)
    before = execute_sql(replica, "SELECT value FROM _sync_state WHERE key='last_push'")
    execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
    original = hub.rows_push

    def reject(table, columns, rows, **kwargs):
        if table == "items":
            return {"upserted": 0, "rejected": [{"id": "a", "rule": "write-conflict"}]}
        return original(table, columns, rows, **kwargs)

    hub.rows_push = reject
    assert sync(replica, hub)["rejected"]
    assert execute_sql(replica, "SELECT value FROM _sync_state WHERE key='last_push'") == before
    assert execute_sql(hub.path, "SELECT * FROM history") == []
    hub.rows_push = original
    assert not sync(replica, hub)["rejected"]
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == 1


def test_new_client_replicates_history_when_old_server_ignores_attachment(hub, tmp_path):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    sync(replica, hub)
    execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
    original_events = execute_sql(replica, "SELECT id FROM history")
    original = hub.rows_push

    def old_server(table, columns, rows, **kwargs):
        # Old hubs ignored extra JSON keys and had no direct-write history.
        if table == "items":
            import json

            from life_data import _upsert_sql

            with connect(hub.path) as c:
                c.execute(_upsert_sql(table, columns), (json.dumps(rows),))
            return {"upserted": len(rows), "rejected": []}
        return original(table, columns, rows)

    hub.rows_push = old_server
    assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT id FROM history") == original_events
    assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT id FROM history") == original_events


def test_sql_cannot_commit_a_different_row_from_validated_row(hub):
    with connect(hub.path) as c:
        c.execute(
            "CREATE TRIGGER clear_name AFTER INSERT ON items BEGIN UPDATE items SET name=NULL WHERE id=NEW.id; END"
        )
    out = push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    assert out["upserted"] == 0
    assert execute_sql(hub.path, "SELECT * FROM items") == []


def test_invalid_history_id_reuse_rolls_back_row_and_does_not_rewrite_events(hub):
    row = {"id": "a", "name": "B", "updated_at": T1}
    assert not hub.rows_push("items", list(row), [row], history=[event("e1", "A", "B")])["rejected"]
    row.update(name="C", updated_at=T2)
    out = hub.rows_push("items", list(row), [row], history=[event("e1", "B", "C")])
    assert out["rejected"][0]["rule"] == "history"
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "B"}]
    assert execute_sql(hub.path, "SELECT old,new FROM history") == [{"old": "A", "new": "B"}]
