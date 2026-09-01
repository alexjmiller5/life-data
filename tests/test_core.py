import json
import sqlite3
import time

import pytest

from life_data import create_table, execute_sql, init, main, resolve_data_dir


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "life.db")


def test_resolve_data_dir_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path / "custom"))
    assert resolve_data_dir() == tmp_path / "custom"


def test_resolve_data_dir_xdg(monkeypatch, tmp_path):
    monkeypatch.delenv("LIFE_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert resolve_data_dir() == tmp_path / "xdg" / "life-data"


def test_resolve_data_dir_default(monkeypatch):
    monkeypatch.delenv("LIFE_DATA_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert str(resolve_data_dir()).endswith(".local/share/life-data")


def test_init_creates_plumbing_and_is_idempotent(tmp_path):
    path = tmp_path / "nested" / "life.db"
    init(path)
    init(path)  # second run must not fail or clobber
    conn = sqlite3.connect(path)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"_schema_log", "_sync_state"} <= tables
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_sql_select_returns_rows_as_dicts(db):
    rows = execute_sql(db, "SELECT 1 AS one, 'a' AS letter")
    assert rows == [{"one": 1, "letter": "a"}]


def test_ddl_is_recorded_in_schema_log(db):
    execute_sql(db, "CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)")
    log = execute_sql(db, "SELECT ddl FROM _schema_log")
    assert log == [{"ddl": "CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)"}]


def test_non_ddl_is_not_recorded(db):
    execute_sql(db, "CREATE TABLE pets (id TEXT PRIMARY KEY)")
    execute_sql(db, "INSERT INTO pets (id) VALUES ('x')")
    log = execute_sql(db, "SELECT ddl FROM _schema_log")
    assert len(log) == 1


def test_create_table_adds_sync_columns(db):
    create_table(db, "people", ["name:text", "birthday:text"])
    cols = {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert {"id", "name", "birthday", "created_at", "updated_at", "deleted_at"} <= cols


def test_create_table_autofills_id_and_timestamps(db):
    create_table(db, "people", ["name:text"])
    execute_sql(db, "INSERT INTO people (name) VALUES ('Ada')")
    row = execute_sql(db, "SELECT id, created_at, updated_at FROM people")[0]
    assert len(row["id"]) == 32  # hex uuid-ish
    assert row["created_at"] == row["updated_at"]


def test_update_bumps_updated_at(db):
    create_table(db, "people", ["name:text"])
    execute_sql(db, "INSERT INTO people (name) VALUES ('Ada')")
    before = execute_sql(db, "SELECT updated_at FROM people")[0]["updated_at"]
    time.sleep(0.002)
    execute_sql(db, "UPDATE people SET name = 'Grace'")
    after = execute_sql(db, "SELECT updated_at FROM people")[0]["updated_at"]
    assert after > before


def test_create_table_is_logged(db):
    create_table(db, "people", ["name:text"])
    log = execute_sql(db, "SELECT ddl FROM _schema_log")
    assert any("CREATE TABLE" in r["ddl"] for r in log)
    assert any("CREATE TRIGGER" in r["ddl"] for r in log)


def test_cli_init_sql_roundtrip(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    assert main(["init"]) == 0
    assert main(["table", "create", "pets", "name:text"]) == 0
    assert main(["sql", "INSERT INTO pets (name) VALUES ('Rex')"]) == 0
    capsys.readouterr()
    assert main(["sql", "SELECT name FROM pets"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out == [{"name": "Rex"}]


def test_cli_path_prints_db_path(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    assert main(["path"]) == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "life.db")
