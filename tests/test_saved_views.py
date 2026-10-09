"""Operator-provisioned shared views and recognized table rename integration."""

import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from test_core import _serve

from soma import (
    HttpHub,
    LocalHub,
    catalog,
    connect,
    create_table,
    execute_sql,
    init,
    insert_rows,
    rename_table,
    sync,
    table_ddl,
)

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "core/schema/saved-views.json").read_text())


@pytest.fixture()
def db(tmp_path):
    path = init(tmp_path / "source.db")
    catalog.ensure_catalog(path)
    create_table(path, "items", ["name:text!", "qty:int"])
    catalog.set_table(path, "items", kind="table", display="name")
    create_table(path, "views", ["name:text!", "tbl:ref!", "definition:json!"])
    catalog.set_property(path, "views", "tbl", ref_table="catalog_tables")
    catalog.set_table(path, "views", kind="table", display="name")
    catalog.set_property(
        path, "views", "definition", source="life-core", source_ref="saved-views/v1"
    )
    insert_rows(
        path,
        "views",
        [{"id": "shared", "name": "Example", "tbl": "items", "definition": '{"version":1}'}],
    )
    return path


def client(path, method, args):
    result = subprocess.run(
        [
            "bun",
            "--eval",
            """
import { Database } from 'bun:sqlite';
import { TestSql } from './core/test/support.ts';
import { createCoreHandlers } from './core/src/index.ts';
const db = new TestSql(); db.db.close(); db.db = new Database(process.argv[1]);
const handlers = createCoreHandlers(db, () => { throw Error('No network in fixture'); }, 'fixture');
try { console.log(JSON.stringify(await handlers[process.argv[2]](JSON.parse(process.argv[3])))); }
finally { db.db.close(); }
""",
            str(path),
            method,
            json.dumps(args),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_manifest_is_exact_operator_schema_and_core_reads_it(db):
    assert MANIFEST["ddl"] == table_ddl("views", ["name:text!", "tbl:ref!", "definition:json!"])
    with connect(db) as conn:
        table = dict(conn.execute("SELECT * FROM catalog_tables WHERE id='views'").fetchone())
        assert {key: table[key] for key in MANIFEST["table"]} == MANIFEST["table"]
        props = {p["id"]: p for p in catalog.properties(conn, "views")}
        for expected in MANIFEST["properties"]:
            assert {key: props[expected["id"]][key] for key in expected} == expected
    result = client(db, "listViews", {"table": "items"})
    assert result["unavailable"] is None
    assert result["views"][0]["view"] == {"table": "items"}


def test_rename_retargets_shared_views_and_journals_the_change(db):
    definition = execute_sql(db, "SELECT definition FROM views")[0]["definition"]
    rename_table(db, "items", "records")
    assert execute_sql(db, "SELECT tbl,definition FROM views") == [
        {"tbl": "records", "definition": definition}
    ]
    assert execute_sql(db, "SELECT col,old,new FROM history WHERE tbl='views'") == [
        {"col": "tbl", "old": "items", "new": "records"}
    ]
    assert client(db, "listViews", {"table": "records"})["views"][0]["view"] == {"table": "records"}


def test_v2_definition_preserves_grouping_and_timezone_across_python_rename(db):
    definition = {
        "version": 2,
        "timeZone": "UTC",
        "groups": [{"match": "any", "filters": [{"column": "qty", "op": "empty"}]}],
    }
    insert_rows(
        db,
        "views",
        [{"id": "v2", "name": "Grouped", "tbl": "items", "definition": json.dumps(definition)}],
    )
    rename_table(db, "items", "records")
    result = client(db, "listViews", {"table": "records"})
    view = next(v for v in result["views"] if v["id"] == "v2")
    assert view["unavailable"] is None
    assert view["definition"] == definition
    assert view["view"] == {"table": "records", "groups": definition["groups"]}


@pytest.mark.parametrize(
    "collision",
    [
        "UPDATE catalog_properties SET source_ref=NULL WHERE id='views.definition'",
        "UPDATE catalog_properties SET type='text' WHERE id='views.definition'",
        "UPDATE catalog_properties SET ref_table='items' WHERE id='views.tbl'",
        "UPDATE catalog_tables SET kind='system' WHERE id='views'",
        "DROP TRIGGER views_updated_at",
        "ALTER TABLE views ADD COLUMN owner_id TEXT",
    ],
)
def test_rename_never_adopts_a_colliding_views_table(db, collision):
    with connect(db) as conn:
        conn.execute(collision)
    before = execute_sql(db, "SELECT * FROM views")
    rename_table(db, "items", "records")
    assert execute_sql(db, "SELECT * FROM views") == before


def test_view_validation_failure_rolls_back_entire_rename(db):
    catalog.set_rule(
        db,
        "hold-view-target",
        kind="invariant",
        tbl="views",
        enforce=1,
        sql="SELECT id FROM changed",
        text="Keep the original target",
    )
    before = execute_sql(db, "SELECT * FROM _schema_log")
    views_before = execute_sql(db, "SELECT * FROM views")
    with pytest.raises(catalog.ValidationError):
        rename_table(db, "items", "records")
    assert execute_sql(db, "SELECT * FROM _schema_log") == before
    assert execute_sql(db, "SELECT id FROM catalog_tables WHERE id='items' AND deleted_at IS NULL")
    assert execute_sql(db, "SELECT tbl FROM views") == [{"tbl": "items"}]
    assert execute_sql(db, "SELECT * FROM views") == views_before


def test_core_writes_sync_between_clients_and_survive_python_rename(db, tmp_path):
    hub = LocalHub(init(tmp_path / "hub.db"))
    sync(db, hub)
    other = init(tmp_path / "other.db")
    sync(other, hub)
    initial = client(other, "listViews", {"table": "items"})["views"][0]
    saved = client(
        other,
        "saveView",
        {
            "id": initial["id"],
            "table": "items",
            "name": "Edited on another client",
            "definition": {"version": 1, "columns": ["name"], "widths": {"name": 920}},
            "expectedUpdatedAt": initial["updated_at"],
        },
    )
    sync(other, hub)
    sync(db, hub)
    assert client(db, "listViews", {"table": "items"})["views"][0] == saved
    rename_table(db, "items", "records")
    sync(db, hub)
    sync(other, hub)
    renamed = client(other, "listViews", {"table": "records"})["views"][0]
    assert renamed["view"] == {"table": "records", "columns": ["name"]}
    assert renamed["definition"]["widths"] == {"name": 920}
    client(other, "deleteView", {"id": renamed["id"], "expectedUpdatedAt": renamed["updated_at"]})
    sync(other, hub)
    sync(db, hub)
    assert client(db, "listViews", {"table": "records"})["views"] == []
    assert (
        client(db, "listViews", {"table": "records", "trash": True})["views"][0]["id"] == "shared"
    )


@pytest.fixture(params=["local", "http"])
def rename_hub(tmp_path, request):
    backing = init(tmp_path / "rename-hub.db")
    if request.param == "local":
        yield LocalHub(backing), backing
        return
    server = _serve(backing)
    try:
        yield (
            HttpHub(
                f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer testtoken"}
            ),
            backing,
        )
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("clock_offset", [-60, 60], ids=["past", "future"])
def test_view_rename_revision_reaches_existing_and_fresh_replicas(
    db, tmp_path, rename_hub, clock_offset
):
    hub, backing = rename_hub
    # Within supported skew, with .999 to exercise carrying into the next second.
    previous = (
        (datetime.now(UTC) + timedelta(seconds=clock_offset))
        .replace(microsecond=999000)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    insert_rows(
        db,
        "views",
        [
            {"id": "trash", "name": "Trashed", "tbl": "items", "definition": '{"version":1}'},
            {
                "id": "untouched",
                "name": "Other target",
                "tbl": "views",
                "definition": '{"version":1}',
            },
        ],
    )
    with connect(db) as conn:
        conn.execute("UPDATE views SET updated_at=?", (previous,))
        conn.execute("UPDATE views SET deleted_at=? WHERE id='trash'", (previous,))
        # The timestamp trigger fires on that tombstone edit; restore the fixture revision.
        conn.execute("UPDATE views SET updated_at=? WHERE id='trash'", (previous,))
    assert sync(db, hub)["rejected"] == []
    other = init(tmp_path / "existing.db")
    assert sync(other, hub)["rejected"] == []
    assert client(other, "listViews", {"table": "items"})["views"][0]["updated_at"] == previous

    rename_table(db, "items", "records")
    assert sync(db, hub)["rejected"] == []
    assert sync(other, hub)["rejected"] == []
    fresh = init(tmp_path / "fresh.db")
    assert sync(fresh, hub)["rejected"] == []
    for replica in [other, fresh]:
        views = client(replica, "listViews", {"table": "records"})["views"]
        assert [view["id"] for view in views] == ["shared"]
        assert views[0]["updated_at"] > previous
        trash = client(replica, "listViews", {"table": "records", "trash": True})["views"]
        assert [view["id"] for view in trash] == ["trash"]
        assert trash[0]["updated_at"] > previous
    for path in [db, backing, other, fresh]:
        assert execute_sql(path, "SELECT tbl,updated_at FROM views WHERE id='untouched'") == [
            {"tbl": "views", "updated_at": previous}
        ]
    assert execute_sql(
        db, "SELECT row_id,col,old,new FROM history WHERE tbl='views' ORDER BY row_id"
    ) == [
        {"row_id": "shared", "col": "tbl", "old": "items", "new": "records"},
        {"row_id": "trash", "col": "tbl", "old": "items", "new": "records"},
    ]
