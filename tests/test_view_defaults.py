"""Preferred view schema, core writes and sync-safe table renames."""

import json
from pathlib import Path

import pytest
from test_saved_views import client
from test_saved_views import db as shared_db

from life_data import catalog, connect, create_table, execute_sql, rename_table, table_ddl


@pytest.fixture()
def db(tmp_path):
    return shared_db.__wrapped__(tmp_path)


MANIFEST = json.loads(
    (Path(__file__).resolve().parents[1] / "core/schema/view-defaults.json").read_text()
)


def provision(path):
    create_table(path, "view_defaults", ["tbl:ref!", "view_id:ref"])
    catalog.set_table(path, "view_defaults", kind="table", display="tbl")
    catalog.set_property(path, "view_defaults", "tbl", ref_table="catalog_tables")
    catalog.set_property(
        path,
        "view_defaults",
        "view_id",
        ref_table="views",
        source="life-core",
        source_ref="view-defaults/v1",
    )


def test_manifest_and_operator_provisioned_core_write(db):
    provision(db)
    assert MANIFEST["ddl"] == table_ddl("view_defaults", ["tbl:ref!", "view_id:ref"])
    saved = client(
        db, "setViewDefault", {"table": "items", "viewId": "shared", "expectedUpdatedAt": None}
    )
    assert saved["view"]["id"] == "shared"
    assert saved["unavailable"] is None


def test_rename_preserves_preference_and_sync_tombstone(db):
    provision(db)
    client(db, "setViewDefault", {"table": "items", "viewId": "shared", "expectedUpdatedAt": None})
    with connect(db) as conn:
        conn.execute("UPDATE view_defaults SET updated_at='2090-01-01T00:00:00.000Z'")
    rename_table(db, "items", "records")
    result = client(db, "getViewDefault", {"table": "records"})
    assert result["viewId"] == "shared"
    assert result["view"]["view"]["table"] == "records"
    assert result["updated_at"] > "2090-01-01T00:00:00.000Z"
    rows = execute_sql(db, "SELECT id,tbl,deleted_at,updated_at FROM view_defaults ORDER BY tbl")
    assert len(rows) == 2
    assert rows[0]["tbl"] == "items" and rows[0]["deleted_at"] is not None
    assert rows[0]["updated_at"] > "2090-01-01T00:00:00.000Z"
    assert rows[1]["tbl"] == "records" and rows[1]["deleted_at"] is None


def test_rename_does_not_adopt_colliding_storage(db):
    provision(db)
    client(db, "setViewDefault", {"table": "items", "viewId": "shared", "expectedUpdatedAt": None})
    with connect(db) as conn:
        conn.execute(
            "UPDATE catalog_properties SET source_ref=NULL WHERE id='view_defaults.view_id'"
        )
    before = execute_sql(db, "SELECT * FROM view_defaults")
    rename_table(db, "items", "records")
    assert execute_sql(db, "SELECT * FROM view_defaults") == before


def test_preference_rule_rolls_back_table_rename(db):
    provision(db)
    client(db, "setViewDefault", {"table": "items", "viewId": "shared", "expectedUpdatedAt": None})
    catalog.set_rule(
        db,
        "hold-default",
        kind="invariant",
        tbl="view_defaults",
        enforce=1,
        sql="SELECT id FROM changed",
        text="Keep preference",
    )
    with pytest.raises(catalog.ValidationError):
        rename_table(db, "items", "records")
    assert client(db, "getViewDefault", {"table": "items"})["viewId"] == "shared"


def test_preference_follows_sync_and_rename_without_duplicate_live_rows(db, tmp_path):
    from life_data import LocalHub, init, sync

    provision(db)
    hub = LocalHub(init(tmp_path / "hub.db"))
    assert not sync(db, hub)["rejected"]  # Provision targets before dependent preferences.
    client(db, "setViewDefault", {"table": "items", "viewId": "shared", "expectedUpdatedAt": None})
    assert not sync(db, hub)["rejected"]
    other = init(tmp_path / "other.db")
    sync(other, hub)
    assert client(other, "getViewDefault", {"table": "items"})["viewId"] == "shared"
    rename_table(db, "items", "records")
    sync(db, hub)
    sync(other, hub)
    result = client(other, "getViewDefault", {"table": "records"})
    assert result["view"]["id"] == "shared"
    assert len(execute_sql(other, "SELECT id FROM view_defaults WHERE deleted_at IS NULL")) == 1
