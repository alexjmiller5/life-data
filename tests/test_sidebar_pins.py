"""Durable sidebar storage provisioning and sync-safe table renames."""

import json
from pathlib import Path

import pytest
from test_saved_views import client

import life_data as life
from life_data import catalog

MANIFEST = json.loads(
    (Path(__file__).resolve().parents[1] / "core/schema/sidebar-pins.json").read_text()
)


@pytest.fixture()
def db(tmp_path):
    path = life.init(tmp_path / "source.db")
    catalog.ensure_catalog(path)
    life.create_table(path, "items", ["name:text!"])
    catalog.set_table(path, "items", kind="table", display="name")
    return path


def pin(path):
    return client(path, "pinTable", {"table": "items", "expectedUpdatedAt": None})["pins"][0]


def test_provision_is_canonical_idempotent_and_logged(db):
    life.provision_sidebar_pins(db)
    assert MANIFEST["ddl"] == life.table_ddl("sidebar_pins", ["tbl:ref!", "position:int!"])
    assert client(db, "listSidebarPins", {}) == {"pins": [], "unavailable": None}
    before = life.dump_sql(db)
    life.provision_sidebar_pins(db)
    assert life.dump_sql(db) == before
    logged = life.execute_sql(db, "SELECT ddl FROM _schema_log WHERE ddl LIKE '%sidebar_pins%'")
    assert [r["ddl"] for r in logged] == MANIFEST["ddl"]


def test_foreign_collision_is_not_adopted(db):
    life.create_table(db, "sidebar_pins", ["content:text"])
    before = life.dump_sql(db)
    with pytest.raises(ValueError, match="schema|storage|collision"):
        life.provision_sidebar_pins(db)
    assert life.dump_sql(db) == before


@pytest.mark.parametrize("deleted", [False, True])
def test_rename_rekeys_pin_preserving_position_and_tombstone(db, deleted):
    life.provision_sidebar_pins(db)
    original = pin(db)
    if deleted:
        client(
            db, "unpinTable", {"id": original["id"], "expectedUpdatedAt": original["updated_at"]}
        )
    life.rename_table(db, "items", "records")
    rows = client(db, "listSidebarPins", {})["pins"]
    old = next(p for p in rows if p["id"] == original["id"])
    new = next(p for p in rows if p["tbl"] == "records")
    assert old["deleted_at"]
    assert new["id"] == "pin:v1:" + b"records".hex()
    assert new["position"] == original["position"]
    assert bool(new["deleted_at"]) == deleted
    assert new["unavailable"] is None


def test_forward_clock_rename_survives_sync_to_second_replica(db, tmp_path):
    life.provision_sidebar_pins(db)
    original = pin(db)
    future = "2099-01-01T00:00:00.000Z"
    with life.connect(db) as conn:
        conn.execute("UPDATE sidebar_pins SET updated_at=? WHERE id=?", (future, original["id"]))
    hub = life.LocalHub(life.init(tmp_path / "hub.db"))
    life.sync(db, hub)
    other = life.init(tmp_path / "other.db")
    life.sync(other, hub)
    life.rename_table(db, "items", "records")
    renamed = client(db, "listSidebarPins", {})["pins"]
    assert all(p["updated_at"] > future for p in renamed)
    life.sync(db, hub)
    life.sync(other, hub)
    assert client(other, "listSidebarPins", {})["pins"] == renamed


def test_destination_pin_collision_rolls_back_entire_rename(db):
    life.provision_sidebar_pins(db)
    pin(db)
    with life.connect(db) as conn:
        conn.execute(
            "INSERT INTO sidebar_pins(id,tbl,position) VALUES (?,?,?)",
            ("pin:v1:" + b"records".hex(), "records", 7),
        )
    before = life.dump_sql(db)
    with pytest.raises(ValueError, match="pin|collision"):
        life.rename_table(db, "items", "records")
    assert life.dump_sql(db) == before


@pytest.mark.parametrize(
    "collision",
    [
        "DROP TRIGGER sidebar_pins_updated_at",
        "UPDATE catalog_properties SET source_ref=NULL WHERE id='sidebar_pins.tbl'",
        "ALTER TABLE sidebar_pins ADD COLUMN foreign_data TEXT",
    ],
)
def test_rename_leaves_unrecognized_pin_storage_untouched(db, collision):
    life.provision_sidebar_pins(db)
    pin(db)
    with life.connect(db) as conn:
        conn.execute(collision)
    before = life.execute_sql(db, "SELECT * FROM sidebar_pins")
    life.rename_table(db, "items", "records")
    assert life.execute_sql(db, "SELECT * FROM sidebar_pins") == before


def test_pin_invariant_failure_rolls_back_the_table_rename(db):
    life.provision_sidebar_pins(db)
    pin(db)
    catalog.set_rule(
        db,
        "hold-pins",
        kind="invariant",
        tbl="sidebar_pins",
        enforce=1,
        sql="SELECT id FROM changed",
        text="Keep pin destinations",
    )
    before = life.dump_sql(db)
    with pytest.raises(catalog.ValidationError):
        life.rename_table(db, "items", "records")
    assert life.dump_sql(db) == before


def test_cli_provisions_without_repository_edits(db, monkeypatch):
    monkeypatch.setattr(life, "db_path", lambda: db)
    assert life.main(["table", "provision", "sidebar-pins"]) == 0
    assert client(db, "listSidebarPins", {})["unavailable"] is None


def test_canonical_ddl_without_catalog_is_not_adopted(tmp_path):
    path = life.init(tmp_path / "foreign.db")
    with life.connect(path) as conn:
        for sql in MANIFEST["ddl"]:
            conn.execute(sql)
    before = life.dump_sql(path)
    with pytest.raises(ValueError, match="collision"):
        life.provision_sidebar_pins(path)
    assert life.dump_sql(path) == before
