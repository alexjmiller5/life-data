"""`life purge`: a content-free marker that syncs like a row and makes the hub
and every replica hard-delete a row (or one column's history) for good."""

import json

import pytest

import life_data as life
from life_data import create_table, execute_sql, init, insert_rows, purge

OLD = "2000-01-01T00:00:00.000Z"
FUTURE = "2099-01-01T00:00:00.000Z"


def _rows(path, table, row_id="r1"):
    return execute_sql(path, f"SELECT * FROM {table} WHERE id = '{row_id}'")


def _history(path, row_id="r1", col=None):
    sql = f"SELECT * FROM history WHERE tbl = 'items' AND row_id = '{row_id}'"
    if col:
        sql += f" AND col = '{col}'"
    return execute_sql(path, sql)


def _edges(path, row_id="r1"):
    return execute_sql(
        path, f"SELECT * FROM provenance WHERE to_kind = 'items' AND to_ref = '{row_id}'"
    )


def _seed(path):
    create_table(path, "items", ["name:text", "note:text"])
    insert_rows(path, "items", [{"id": "r1", "name": "secret", "note": "n0"}])
    execute_sql(path, "UPDATE items SET name = 'more secret', note = 'n1' WHERE id = 'r1'")
    insert_rows(
        path,
        "provenance",
        [
            {
                "id": "manual:x:r1",
                "from_kind": "manual",
                "from_ref": "x",
                "to_kind": "items",
                "to_ref": "r1",
                "rel": "evidence_of",
                "asserted_by": "test",
            }
        ],
    )


@pytest.fixture()
def db(tmp_path):
    path = init(tmp_path / "a.db")
    _seed(path)
    return path


@pytest.fixture()
def pair(tmp_path):
    """Two replicas that share one hub and hold the same secret row."""
    a = init(tmp_path / "a.db")
    _seed(a)
    hub = life.LocalHub(tmp_path / "hub.db")
    b = init(tmp_path / "b.db")
    assert not life.sync(a, hub)["rejected"]
    assert not life.sync(b, hub)["rejected"]
    assert _rows(b, "items") and _history(b)
    return a, b, hub


def test_purge_row_deletes_row_history_and_edges_and_leaves_a_contentless_marker(db):
    assert purge(db, "items", "r1") == {"markers": 1}
    assert _rows(db, "items") == []
    assert _history(db) == []
    assert _edges(db) == []
    [marker] = execute_sql(db, "SELECT * FROM purges")
    assert (marker["tbl"], marker["row_id"], marker["col"]) == ("items", "r1", None)
    assert "secret" not in json.dumps(marker)


def test_purge_column_deletes_only_that_columns_history(db):
    assert purge(db, "items", "r1", cols=["name"]) == {"markers": 1}
    assert _rows(db, "items"), "a column purge keeps the row"
    assert _history(db, col="name") == []
    assert _history(db, col="note"), "other columns keep their history"


def test_purging_again_keeps_one_marker_and_removes_a_recreated_row(db, monkeypatch):
    ticks = ["2030-01-01T00:00:00.000Z"]
    real = life.connect

    def clocked(path, manual_tx=False):
        conn = real(path, manual_tx)
        conn.create_function("strftime", 2, lambda *_: ticks[0])
        return conn

    monkeypatch.setattr(life, "connect", clocked)
    purge(db, "items", "r1")
    with real(db) as conn:  # a source re-import lands after the first purge
        conn.execute(
            "INSERT INTO items (id, name, updated_at) "
            "VALUES ('r1', 're-imported', '2030-01-01T00:00:01.000Z')"
        )
    ticks[0] = "2030-01-01T00:00:02.000Z"
    assert purge(db, "items", "r1") == {"markers": 1}
    assert _rows(db, "items") == []
    [marker] = execute_sql(db, "SELECT * FROM purges")
    assert marker["purged_at"] == ticks[0]


@pytest.mark.parametrize(
    "table", ["history", "purges", "provenance", "catalog_properties", "_sync_state"]
)
def test_purge_refuses_engine_tables(db, table):
    with pytest.raises(ValueError, match="engine table"):
        purge(db, table, "r1")


def test_purge_refuses_unknown_table_and_column(db):
    with pytest.raises(ValueError, match="no such table"):
        purge(db, "nope", "r1")
    with pytest.raises(ValueError, match="no such column"):
        purge(db, "items", "r1", cols=["nope"])


def test_purge_reaches_the_hub_and_the_other_replica(pair):
    a, b, hub = pair
    purge(a, "items", "r1")
    assert not life.sync(a, hub)["rejected"]
    assert _rows(hub.path, "items") == []
    assert _history(hub.path) == []
    assert _edges(hub.path) == []
    assert not life.sync(b, hub)["rejected"]
    assert _rows(b, "items") == []
    assert _history(b) == []
    assert _edges(b) == []


def test_column_purge_reaches_the_hub_and_the_other_replica(pair):
    a, b, hub = pair
    purge(a, "items", "r1", cols=["name"])
    life.sync(a, hub)
    life.sync(b, hub)
    for path in (hub.path, b):
        assert _rows(path, "items")
        assert _history(path, col="name") == []
        assert _history(path, col="note")


def test_a_stale_replica_cannot_bring_a_purged_row_back(pair):
    a, b, hub = pair
    # B edits the row while it has not heard of the purge yet
    execute_sql(b, "UPDATE items SET name = 'edited offline' WHERE id = 'r1'")
    purge(a, "items", "r1")
    life.sync(a, hub)
    assert not life.sync(b, hub)["rejected"]
    for path in (hub.path, b):
        assert _rows(path, "items") == []
        assert _history(path) == []


def test_the_hub_drops_old_copies_pushed_by_an_unupgraded_client(pair):
    a, _, hub = pair
    purge(a, "items", "r1")
    life.sync(a, hub)
    out = hub.rows_push(
        "items", ["id", "name", "updated_at"], [{"id": "r1", "name": "x", "updated_at": OLD}]
    )
    assert out["rejected"] == [], "dropping is silent: a rejection would pin the push cursor"
    event = {
        "id": "e1",
        "tbl": "items",
        "row_id": "r1",
        "col": "name",
        "old": "a",
        "new": "b",
        "origin": "old-mac",
        "created_at": OLD,
        "updated_at": OLD,
    }
    out = hub.rows_push("history", list(event), [event])
    assert out["rejected"] == []
    assert _rows(hub.path, "items") == []
    assert _history(hub.path) == []


def test_a_row_recreated_after_the_purge_is_accepted(pair):
    a, _, hub = pair
    purge(a, "items", "r1")
    life.sync(a, hub)
    out = hub.rows_push(
        "items", ["id", "name", "updated_at"], [{"id": "r1", "name": "new", "updated_at": FUTURE}]
    )
    assert out["upserted"] == 1
    assert _rows(hub.path, "items")[0]["name"] == "new"


def test_cli_purge(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    path = init(tmp_path / "life.db")
    _seed(path)
    assert life.main(["purge", "items", "r1", "--col", "name"]) == 0
    assert _history(path, col="name") == []
    assert life.main(["purge", "items", "r1"]) == 0
    assert _rows(path, "items") == []
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1]) == {"markers": 1}


def test_a_replica_does_not_send_covered_copies(pair):
    a, b, hub = pair
    execute_sql(b, "UPDATE items SET name = 'edited offline' WHERE id = 'r1'")
    purge(a, "items", "r1")
    life.sync(a, hub)
    sent = []
    push = hub.rows_push

    def spy(table, columns, rows, **kw):
        sent.extend((table, r) for r in rows)
        sent.extend(("history", e) for e in kw.get("history") or [])
        return push(table, columns, rows, **kw)

    hub.rows_push = spy
    life.sync(b, hub)
    assert not [r for t, r in sent if t == "items" and r["id"] == "r1"]
    assert not [e for t, e in sent if t == "history" and e.get("row_id") == "r1"]


def test_the_hub_drops_covered_history_attached_to_a_newer_push(pair):
    a, _, hub = pair
    purge(a, "items", "r1")
    life.sync(a, hub)
    event = {
        "id": "e-old",
        "tbl": "items",
        "row_id": "r1",
        "col": "name",
        "old": "secret",
        "new": "x",
        "origin": "old-mac",
        "created_at": OLD,
        "updated_at": OLD,
    }
    hub.rows_push(
        "items",
        ["id", "name", "updated_at"],
        [{"id": "r1", "name": "x", "updated_at": FUTURE}],
        history=[event],
    )
    assert not execute_sql(hub.path, "SELECT * FROM history WHERE id = 'e-old'")
