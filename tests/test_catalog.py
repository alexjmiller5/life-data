import pytest

from life_data import connect, execute_sql, init
from life_data.catalog import (
    ensure_catalog,
    has_catalog,
    properties,
    rm_property,
    rules,
    set_property,
    set_rule,
    set_table,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "life.db")


def test_ensure_catalog_creates_logged_tables(db):
    ensure_catalog(db)
    names = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "catalog_tables",
        "catalog_properties",
        "catalog_rules",
        "provenance",
        "catalog_log",
    } <= names
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert any("catalog_properties" in d for d in ddls)
    ensure_catalog(db)  # idempotent
    assert len([d for d in ddls if "CREATE TABLE catalog_properties" in d]) == 1


def test_has_catalog_false_on_fresh_db(db):
    with connect(db) as conn:
        assert has_catalog(conn) is False
    ensure_catalog(db)
    with connect(db) as conn:
        assert has_catalog(conn) is True


def test_set_property_upserts_and_parses(db):
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        options=[{"v": "want"}, {"v": "been", "d": "confirmed"}],
    )
    set_property(db, "places", "status", description="lowercase")
    with connect(db) as conn:
        props = properties(conn, "places")
    assert len(props) == 1
    p = props[0]
    assert p["id"] == "places.status" and p["type"] == "select" and p["required"] == 1
    assert p["options"][1] == {"v": "been", "d": "confirmed"}
    assert p["description"] == "lowercase"


def test_set_property_rejects_unknown_type(db):
    with pytest.raises(ValueError, match="type"):
        set_property(db, "places", "x", type="blob")


def test_rm_property_soft_deletes(db):
    set_property(db, "places", "status", type="text")
    rm_property(db, "places", "status")
    with connect(db) as conn:
        assert properties(conn, "places") == []
    row = execute_sql(db, "SELECT deleted_at FROM catalog_properties WHERE id='places.status'")[0]
    assert row["deleted_at"] is not None


def test_set_rule_and_set_table(db):
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    set_table(db, "places", kind="table", purpose="somewhere real")
    with connect(db) as conn:
        assert rules(conn, kind="doctrine")[0]["id"] == "estate-soft-delete"
    t = execute_sql(db, "SELECT purpose FROM catalog_tables WHERE id='places'")[0]
    assert t["purpose"] == "somewhere real"


def test_catalog_writes_are_logged(db):
    set_property(db, "places", "status", type="text")
    set_rule(db, "r1", scope="estate", kind="doctrine", text="x")
    log = execute_sql(db, "SELECT tbl, row_id, action FROM catalog_log ORDER BY created_at")
    assert log[0] == {"tbl": "catalog_properties", "row_id": "places.status", "action": "set"}
    assert log[1] == {"tbl": "catalog_rules", "row_id": "r1", "action": "set"}
