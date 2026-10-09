"""Operator-defined metadata rules use the same transaction as catalog edits."""

import pytest

from soma import connect, create_table, execute_sql, init, main
from soma.catalog import ValidationError, check, rm_property, set_property, set_rule


def test_first_command_can_create_documented_table_in_empty_data_directory(tmp_path, monkeypatch):
    directory = tmp_path / "new" / "data"
    monkeypatch.setenv("SOMA_DATA_DIR", str(directory))
    assert (
        main(["table", "create", "items", "name:text", "--description", "name=Display name."]) == 0
    )
    path = directory / "soma.db"
    assert execute_sql(
        path, "SELECT description FROM catalog_properties WHERE id='items.name'"
    ) == [{"description": "Display name."}]
    assert len(execute_sql(path, "SELECT ddl FROM _schema_log WHERE ddl LIKE '%\"items\"%'")) == 2


@pytest.fixture
def db(tmp_path):
    path = init(tmp_path / "soma.db")
    create_table(path, "items", ["name:text"])
    set_rule(
        path,
        "described-properties",
        scope="table",
        tbl="catalog_properties",
        kind="invariant",
        enforce=1,
        text="Describe new or changed properties.",
        sql="SELECT id FROM changed WHERE deleted_at IS NULL "
        "AND (description IS NULL OR trim(description, char(9)||char(10)||char(13)||' ') = '')",
    )
    return path


def test_property_set_rejects_undocumented_changes_atomically(db):
    before = execute_sql(db, "SELECT * FROM catalog_log")
    with pytest.raises(ValidationError):
        set_property(db, "items", "name", label="Name")
    assert execute_sql(db, "SELECT label FROM catalog_properties WHERE id='items.name'") == [
        {"label": None}
    ]
    assert execute_sql(db, "SELECT * FROM catalog_log") == before
    set_property(db, "items", "name", description="Name used to identify an item.")
    set_property(db, "items", "name", label="Name")
    with pytest.raises(ValidationError):
        set_property(db, "items", "name", description=" \t\n")


def test_metadata_sql_cannot_bypass_policy_but_old_data_remains_editable(db):
    with pytest.raises(ValidationError):
        execute_sql(db, "UPDATE catalog_properties SET label='Name' WHERE id='items.name'")
    execute_sql(db, "INSERT INTO items(id,name) VALUES ('one','Item')")
    execute_sql(db, "UPDATE items SET name='Renamed' WHERE id='one'")
    assert execute_sql(db, "SELECT name FROM items") == [{"name": "Renamed"}]
    assert any(v["rule"] == "described-properties" for v in check(db))
    rm_property(db, "items", "name")
    with pytest.raises(ValidationError):
        set_property(db, "items", "name", label="Restored")


def test_table_creation_and_catalog_are_one_transaction(db):
    before = execute_sql(db, "SELECT * FROM _schema_log")
    with pytest.raises(ValidationError):
        create_table(db, "other", ["name:text", "details:text"])
    assert execute_sql(db, "SELECT name FROM sqlite_master WHERE name='other'") == []
    assert execute_sql(db, "SELECT * FROM _schema_log") == before
    assert execute_sql(db, "SELECT id FROM catalog_properties WHERE tbl='other'") == []
    create_table(
        db,
        "other",
        ["name:text", "details:text"],
        descriptions={"name": "Display name.", "details": "Additional item details."},
    )
    assert execute_sql(
        db, "SELECT col,description FROM catalog_properties WHERE tbl='other' ORDER BY col"
    ) == [
        {"col": "details", "description": "Additional item details."},
        {"col": "name", "description": "Display name."},
    ]


def test_cli_descriptions_and_unknown_columns(db, monkeypatch, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(db.parent))
    main(["table", "create", "documented", "name:text", "--description", "name=Name = label."])
    assert "created table documented" in capsys.readouterr().out
    with pytest.raises(ValueError, match="description"):
        create_table(db, "bad", ["name:text"], descriptions={"missing": "Unknown."})
    assert execute_sql(db, "SELECT name FROM sqlite_master WHERE name='bad'") == []


def test_rule_can_reject_invalid_names_without_renaming_existing_definitions(db):
    set_rule(
        db,
        "property-names",
        scope="table",
        tbl="catalog_properties",
        kind="invariant",
        enforce=1,
        text="Use lowercase snake_case property names.",
        sql="SELECT id FROM changed WHERE deleted_at IS NULL AND "
        "(col GLOB '*[^a-z0-9_]*' OR col NOT GLOB '[a-z]*')",
    )
    with pytest.raises(ValidationError):
        set_property(db, "items", "BadName", description="Invalid name.")
    with connect(db) as conn:
        assert (
            conn.execute("SELECT 1 FROM catalog_properties WHERE col='BadName'").fetchone() is None
        )


def test_local_hub_applies_same_metadata_policy(db):
    from soma import LocalHub

    hub = LocalHub(db)
    edit = {"id": "items.name", "label": "Name", "updated_at": "2099-01-01T00:00:00.000Z"}
    rejected = hub.rows_push("catalog_properties", list(edit), [edit])
    assert rejected["upserted"] == 0
    assert rejected["rejected"][0]["rule"] == "described-properties"
    edit["description"] = "Item display name."
    assert hub.rows_push("catalog_properties", list(edit), [edit])["rejected"] == []


def test_purge_initialization_remains_usable_under_description_policy(db):
    from soma import purge

    execute_sql(db, "INSERT INTO items(id,name) VALUES ('one','Item')")
    purge(db, "items", "one")
    assert execute_sql(db, "SELECT id FROM items") == []
    assert all(
        r["description"]
        for r in execute_sql(db, "SELECT description FROM catalog_properties WHERE tbl='purges'")
    )
