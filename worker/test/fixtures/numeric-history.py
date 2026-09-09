"""Generate a real local edit and its LocalHub receipt in disposable stores."""

import json
import tempfile
from pathlib import Path

from life_data import LocalHub, catalog, create_table, execute_sql, init, sync

catalog.ORIGIN = "replica"
with tempfile.TemporaryDirectory() as directory:
    hub = LocalHub(init(Path(directory) / "hub.db"))
    create_table(hub.path, "items", ["qty:number"])
    columns = ["id", "qty", "updated_at"]
    hub.rows_push(
        "items", columns, [{"id": "a", "qty": 1e-7, "updated_at": "2025-01-01T00:00:00.000Z"}]
    )
    replica = init(Path(directory) / "replica.db")
    sync(replica, hub)
    execute_sql(replica, "UPDATE items SET qty=0.0000002 WHERE id='a'")
    event = execute_sql(replica, "SELECT * FROM history")[0]
    row = execute_sql(replica, "SELECT id,qty,updated_at FROM items")[0]
    results = []
    for _ in range(2):
        result = hub.rows_push("items", columns, [row], history=[event])
        results.append(
            {
                "upserted": result["upserted"],
                "rejected": result["rejected"],
                "history": execute_sql(hub.path, "SELECT id,old,new,origin FROM history"),
            }
        )
    print(
        json.dumps(
            {
                "body": {"table": "items", "columns": columns, "rows": [row], "history": [event]},
                "results": results,
            }
        )
    )
