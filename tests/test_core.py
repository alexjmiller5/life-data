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


def test_insert_rows_bulk(db):
    from life_data import insert_rows

    create_table(db, "people", ["name:text"])
    n = insert_rows(db, "people", [{"name": "Ada"}, {"name": "Grace"}])
    assert n == 2
    names = {r["name"] for r in execute_sql(db, "SELECT name FROM people")}
    assert names == {"Ada", "Grace"}


def test_insert_rows_preserves_explicit_id_and_created_at(db):
    from life_data import insert_rows

    create_table(db, "people", ["name:text"])
    insert_rows(
        db, "people", [{"id": "a" * 32, "name": "Ada", "created_at": "2020-01-01T00:00:00.000Z"}]
    )
    row = execute_sql(db, "SELECT id, created_at FROM people")[0]
    assert row["id"] == "a" * 32
    assert row["created_at"] == "2020-01-01T00:00:00.000Z"


def test_insert_rows_serializes_lists_as_json(db):
    from life_data import insert_rows

    create_table(db, "people", ["name:text", "tags:text"])
    insert_rows(db, "people", [{"name": "Ada", "tags": ["friend", "colleague"]}])
    row = execute_sql(db, "SELECT tags FROM people")[0]
    assert json.loads(row["tags"]) == ["friend", "colleague"]


def test_cli_insert_reads_json_from_stdin(monkeypatch, tmp_path, capsys):
    import io

    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    main(["init"])
    main(["table", "create", "pets", "name:text"])
    monkeypatch.setattr("sys.stdin", io.StringIO('[{"name": "Rex"}, {"name": "Toto"}]'))
    assert main(["insert", "pets"]) == 0
    capsys.readouterr()
    main(["sql", "SELECT count(*) AS n FROM pets"])
    assert json.loads(capsys.readouterr().out) == [{"n": 2}]


# --- sync engine (hub = injectable SQL target; LocalTarget in tests, D1 in prod) ---


@pytest.fixture()
def hub(tmp_path):
    from life_data import LocalTarget

    return LocalTarget(tmp_path / "hub.db")


def _mk_people(path, names):
    create_table(path, "people", ["name:text"])
    from life_data import insert_rows

    insert_rows(path, "people", [{"name": n} for n in names])


def test_sync_pushes_schema_and_rows_to_hub(db, hub):
    from life_data import sync

    _mk_people(db, ["Ada", "Grace"])
    stats = sync(db, hub)
    assert stats["pushed"] == 2
    assert {r["name"] for r in hub.query("SELECT name FROM people")} == {"Ada", "Grace"}


def test_second_sync_is_noop(db, hub):
    from life_data import sync

    _mk_people(db, ["Ada"])
    sync(db, hub)
    stats = sync(db, hub)
    assert stats["pushed"] == 0 and stats["pulled"] == 0 and stats["ddl_applied"] == 0


def test_sync_pulls_hub_rows(db, hub, tmp_path):
    from life_data import sync

    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    stats = sync(other, hub)
    assert stats["ddl_applied"] >= 1  # schema replayed from hub
    assert stats["pulled"] == 1
    assert execute_sql(other, "SELECT name FROM people")[0]["name"] == "Ada"


def test_lww_newer_edit_wins(db, hub, tmp_path):
    from life_data import sync

    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'Ada Lovelace'")
    time.sleep(0.002)
    execute_sql(db, "UPDATE people SET name = 'Countess Ada'")  # newer
    sync(other, hub)  # other pushes its edit
    sync(db, hub)  # db pulls other's edit but its own is newer -> keeps, pushes
    sync(other, hub)  # other pulls db's newer edit
    assert execute_sql(db, "SELECT name FROM people")[0]["name"] == "Countess Ada"
    assert execute_sql(other, "SELECT name FROM people")[0]["name"] == "Countess Ada"
    assert hub.query("SELECT name FROM people")[0]["name"] == "Countess Ada"


def test_soft_delete_propagates(db, hub, tmp_path):
    from life_data import sync

    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    sync(other, hub)
    execute_sql(db, "UPDATE people SET deleted_at = updated_at")
    sync(db, hub)
    sync(other, hub)
    assert execute_sql(other, "SELECT deleted_at FROM people")[0]["deleted_at"] is not None


def test_backup_writes_sql_dump(db, tmp_path):
    from life_data import dump_sql

    _mk_people(db, ["Ada"])
    text = dump_sql(db)
    assert "CREATE TABLE" in text and "Ada" in text


def test_fresh_replica_does_not_echo_pulled_rows(db, hub, tmp_path):
    from life_data import sync

    _mk_people(db, ["Ada", "Grace"])
    sync(db, hub)
    other = init(tmp_path / "other" / "life.db")
    stats = sync(other, hub)
    assert stats["pulled"] == 2
    assert stats["pushed"] == 0
