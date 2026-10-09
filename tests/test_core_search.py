"""Shared-file search compatibility through the real Python catalog writer."""

import json
import subprocess
from pathlib import Path

import pytest

from soma import catalog, create_table, execute_sql, init, insert_rows

ROOT = Path(__file__).resolve().parents[1]


def search(path, text):
    result = subprocess.run(
        [
            "bun",
            "--eval",
            """
import { Database } from 'bun:sqlite';
import { TestSql } from './core/test/support.ts';
import { search } from './core/src/index.ts';
const db = new TestSql(); db.db.close(); db.db = new Database(process.argv[1]);
try { console.log(JSON.stringify(await search(db, { text: process.argv[2], table: 'documents' }))); }
finally { db.db.close(); }
""",
            str(path),
            text,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return [hit["id"] for hit in json.loads(result.stdout)]


def test_search_cache_does_not_interfere_with_python_validation_or_history(tmp_path):
    path = init(tmp_path / "fixture.db")
    catalog.ensure_catalog(path)
    create_table(path, "documents", ["title:text!", "body:markdown"])
    catalog.set_table(path, "documents", display="title")
    insert_rows(path, "documents", [{"id": "a", "title": "Example", "body": "# Original"}])
    assert search(path, "original") == ["a"]

    execute_sql(path, "UPDATE documents SET body='**Committed revision**' WHERE id='a'")
    assert search(path, "committed") == ["a"]
    assert search(path, "original") == []
    assert execute_sql(path, "SELECT old,new FROM history WHERE tbl='documents'") == [
        {"old": "# Original", "new": "**Committed revision**"}
    ]

    with pytest.raises(catalog.ValidationError):
        execute_sql(path, "UPDATE documents SET title=NULL,body='Rejected' WHERE id='a'")
    assert search(path, "rejected") == []
    assert search(path, "committed") == ["a"]
    execute_sql(path, "DELETE FROM documents WHERE id='a'")
    assert search(path, "committed") == []
    assert execute_sql(path, "SELECT ddl FROM _schema_log WHERE ddl LIKE '%_core_search_%'") == []
    assert execute_sql(path, "SELECT tbl FROM history WHERE tbl LIKE '_core_search_%'") == []
