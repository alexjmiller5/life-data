"""The UI's app-owned audit storage uses the operator's engine DDL."""

import json
from pathlib import Path

from soma import table_ddl
from soma.catalog import CATALOG_TABLES


def test_catalog_log_manifest_uses_engine_ddl():
    manifest = json.loads(
        (Path(__file__).resolve().parents[1] / "core/schema/catalog-log.json").read_text()
    )
    assert manifest["ddl"] == table_ddl("catalog_log", CATALOG_TABLES["catalog_log"])
    assert manifest["table"]["kind"] == "system"
    assert [p["col"] for p in manifest["properties"]] == ["tbl", "row_id", "action", "payload"]
