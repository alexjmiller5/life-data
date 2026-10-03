"""One-row context parity with the fixtures run by core against the Worker."""

import json
from pathlib import Path

import pytest
from test_core import _serve

from life_data import (
    NOW,
    HttpHub,
    catalog,
    create_table,
    execute_sql,
    init,
    insert_rows,
    qi,
    sync,
)

RULES = json.loads((Path(__file__).parent / "fixtures/table-invariants.json").read_text())
T0 = "2025-01-01T00:00:00.000Z"


def update(path, patch):
    def write(conn):
        values = dict(patch)
        if values.get("deleted_at") is True:
            values["deleted_at"] = conn.execute(f"SELECT {NOW}").fetchone()[0]
        conn.execute(
            f"UPDATE items SET {','.join(f'{qi(col)}=?' for col in values)} WHERE id=?",
            [*values.values(), "edited"],
        )

    return catalog.write(path, write)


@pytest.mark.parametrize("rule", RULES, ids=lambda rule: rule["id"])
def test_contexts_roundtrip_python_origin_http_hub_and_replica(tmp_path, rule):
    source = init(tmp_path / "origin.db")
    catalog.ensure_catalog(source)
    create_table(source, "items", ["name:text", "qty:int"])
    create_table(source, "limits", ["qty:int"])
    insert_rows(
        source,
        "items",
        [
            {"id": "edited", "name": "Initial", "qty": 2, "updated_at": T0},
            {"id": "untouched", "name": "Initial", "qty": 7, "updated_at": T0},
        ],
    )
    insert_rows(source, "limits", [{"id": "cap", "qty": 5}])
    server = _serve(tmp_path / "hub.db")
    try:
        hub = HttpHub(
            f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer testtoken"}
        )
        assert sync(source, hub)["rejected"] == []
        catalog.set_rule(
            source,
            rule["id"],
            tbl="items",
            kind="invariant",
            enforce=1,
            sql=rule["sql"],
            text=rule["text"],
        )
        assert sync(source, hub)["rejected"] == []
        before = execute_sql(source, "SELECT * FROM items ORDER BY id")
        with pytest.raises(catalog.ValidationError) as error:
            update(source, rule["blocked"])
        assert error.value.violations[0].rule == rule["id"]
        assert execute_sql(source, "SELECT * FROM items ORDER BY id") == before
        assert execute_sql(source, "SELECT * FROM history WHERE tbl='items'") == []
        update(source, rule["allowed"])
        assert sync(source, hub)["rejected"] == []
        other = init(tmp_path / "replica.db")
        sync(other, hub)
        query = "SELECT id,name,qty,deleted_at FROM items ORDER BY id"
        assert execute_sql(other, query) == execute_sql(source, query)
        query = "SELECT id,col,old,new FROM history WHERE tbl='items' ORDER BY id"
        assert execute_sql(other, query) == execute_sql(source, query)
    finally:
        server.shutdown()
        server.server_close()
