"""Deterministic sync regressions. Every database and endpoint is synthetic."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

import soma

T0 = "2026-01-01T00:00:00.000Z"
T1 = "2026-01-01T00:00:01.000Z"
T2 = "2026-01-01T00:00:02.000Z"
FUTURE = "2099-01-01T00:00:00.000Z"


@pytest.fixture
def clock(monkeypatch):
    ticks = [T0]
    connect = soma.connect

    def clocked_connect(path, manual_tx=False):
        conn = connect(path, manual_tx)
        conn.create_function("strftime", 2, lambda *_: ticks[0])
        return conn

    monkeypatch.setattr(soma, "connect", clocked_connect)
    return ticks


@pytest.fixture
def estate(tmp_path, clock):
    path = soma.init(tmp_path / "replica.db")
    soma.create_table(path, "items", ["name:text"])
    hub = soma.LocalHub(tmp_path / "hub.db")
    soma.sync(path, hub)
    return path, hub


def state(path):
    return {r["key"]: r["value"] for r in soma.execute_sql(path, "SELECT * FROM _sync_state")}


def ids(hub):
    return {r["id"] for r in hub.rows_pull("items", ["id"], "")}


def test_raw_nonsyncable_table_does_not_block_supported_writes(estate):
    path, _ = estate
    soma.execute_sql(path, 'CREATE TABLE "raw-table" (value TEXT)')
    soma.insert_rows(path, "items", [{"id": "after-raw"}])
    soma.execute_sql(path, 'DROP TABLE "raw-table"')
    assert soma.execute_sql(path, "SELECT id FROM items") == [{"id": "after-raw"}]


def test_virtual_table_does_not_block_supported_writes(estate):
    path, _ = estate
    soma.execute_sql(path, "CREATE VIRTUAL TABLE lookup USING fts5(id, updated_at)")
    soma.insert_rows(path, "items", [{"id": "after-virtual"}])
    soma.execute_sql(path, "DROP TABLE lookup")
    assert soma.execute_sql(path, "SELECT id FROM items") == [{"id": "after-virtual"}]


def test_purge_during_temporary_clock_rollback_still_reaches_hub(estate, clock):
    path, hub = estate
    soma.insert_rows(path, "items", [{"id": "purged"}])
    clock[0] = T2
    soma.sync(path, hub)
    clock[0] = T1
    soma.purge(path, "items", "purged")
    clock[0] = "2026-01-01T00:00:03.000Z"
    assert not soma.sync(path, hub)["rejected"]
    assert "purged" not in ids(hub)
    assert hub.rows_pull("purges", ["tbl", "row_id"], "") == [{"tbl": "items", "row_id": "purged"}]


@pytest.mark.parametrize("writer", ["insert", "sql"])
def test_backdated_new_rows_are_local_changes(estate, clock, writer):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    if writer == "insert":
        soma.insert_rows(path, "items", [{"id": "old", "updated_at": T0}])
    else:
        soma.execute_sql(path, f"INSERT INTO items (id,updated_at) VALUES ('old','{T0}')")
    assert not soma.sync(soma.init(path), hub)["rejected"]
    assert "old" in ids(hub)
    assert hub.rows_pull("items", ["updated_at"], "")[0]["updated_at"] == T0


@pytest.mark.parametrize("failure", ["interrupt", "reject"])
def test_backdated_changes_retry_after_failure(estate, clock, monkeypatch, failure):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    soma.insert_rows(path, "items", [{"id": "old", "updated_at": T0}])
    original = hub.rows_push

    def failing(table, cols, rows, **kwargs):
        if table == "items":
            if failure == "interrupt":
                raise OSError("synthetic interruption")
            return {"upserted": 0, "rejected": [{"id": "old", "rule": "retry"}]}
        return original(table, cols, rows, **kwargs)

    with monkeypatch.context() as m:
        m.setattr(hub, "rows_push", failing)
        if failure == "interrupt":
            with pytest.raises(OSError, match="synthetic"):
                soma.sync(path, hub)
        else:
            assert soma.sync(path, hub)["rejected"]
    assert not soma.sync(soma.init(path), hub)["rejected"]
    assert "old" in ids(hub)


def test_backdated_edit_during_push_survives_old_receipt(estate, clock, monkeypatch):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    soma.insert_rows(path, "items", [{"id": "old", "name": "first", "updated_at": T0}])
    original = hub.rows_push

    def pushing(table, cols, rows, **kwargs):
        if table == "items":
            soma.execute_sql(
                path, f"UPDATE items SET name='second', updated_at='{T1}' WHERE id='old'"
            )
        return original(table, cols, rows, **kwargs)

    with monkeypatch.context() as m:
        m.setattr(hub, "rows_push", pushing)
        assert not soma.sync(path, hub)["rejected"]
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("items", ["id", "name", "updated_at"], "") == [
        {"id": "old", "name": "second", "updated_at": T1}
    ]


def test_backdated_changes_follow_table_rename(estate, clock):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    soma.insert_rows(path, "items", [{"id": "old", "updated_at": T0}])
    soma.rename_table(path, "items", "renamed")
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("renamed", ["id"], "") == [{"id": "old"}]


def test_backdated_changes_follow_remote_table_rename(estate, clock):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    soma.insert_rows(path, "items", [{"id": "old", "updated_at": T0}])
    hub.schema_push([{"applied_at": T2, "ddl": 'ALTER TABLE "items" RENAME TO "renamed"'}])
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("renamed", ["id"], "") == [{"id": "old"}]


def test_rename_reusing_dropped_table_merges_dirty_receipts(estate, clock):
    path, hub = estate
    for table in ("first", "second"):
        soma.execute_sql(
            path,
            f"CREATE TABLE {table} (id TEXT PRIMARY KEY, updated_at TEXT, hub_at TEXT)",
        )
    clock[0] = T2
    soma.sync(path, hub)
    for table in ("first", "second"):
        soma.insert_rows(path, table, [{"id": "same", "updated_at": T0}])
    before = soma.execute_sql(path, "SELECT max(seq) AS seq FROM _sync_dirty")[0]["seq"]
    soma.execute_sql(path, "DROP TABLE second")
    soma.rename_table(path, "first", "second")
    assert (
        soma.execute_sql(path, "SELECT seq FROM _sync_dirty WHERE tbl='second' AND row_id='same'")[
            0
        ]["seq"]
        > before
    )
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("second", ["id", "updated_at"], "") == [{"id": "same", "updated_at": T0}]


def test_backdated_conflict_keeps_newer_hub_value(estate, clock):
    path, hub = estate
    row = {"id": "same", "name": "newer", "updated_at": T1}
    hub.rows_push("items", list(row), [row])
    clock[0] = T2
    soma.sync(path, hub)
    soma.execute_sql(path, f"UPDATE items SET name='older', updated_at='{T0}' WHERE id='same'")
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("items", ["name", "updated_at"], "") == [
        {"name": "newer", "updated_at": T1}
    ]


def test_ignore_upsert_and_delete_preserve_dirty_generation(estate, clock, monkeypatch):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    soma.execute_sql(
        path, f"INSERT OR IGNORE INTO items (id,name,updated_at) VALUES ('old','first','{T0}')"
    )
    original = hub.rows_push

    def pushing(table, cols, rows, **kwargs):
        if table == "items":
            soma.execute_sql(
                path,
                f"UPDATE OR IGNORE items SET deleted_at='{T1}', updated_at='{T1}' WHERE id='old'",
            )
        return original(table, cols, rows, **kwargs)

    with monkeypatch.context() as m:
        m.setattr(hub, "rows_push", pushing)
        soma.sync(path, hub)
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("items", ["deleted_at"], "") == [{"deleted_at": T1}]


def test_backdated_changes_on_uncataloged_table(estate, clock):
    path, hub = estate
    soma.execute_sql(path, "CREATE TABLE raw (id TEXT PRIMARY KEY, updated_at TEXT, hub_at TEXT)")
    clock[0] = T2
    soma.sync(path, hub)
    soma.execute_sql(path, f"INSERT INTO raw VALUES ('old','{T0}',NULL)")
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("raw", ["id"], "") == [{"id": "old"}]


def test_rollback_and_remote_pulls_do_not_queue_local_changes(estate, clock):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    soma.catalog.set_property(path, "items", "name", required=1)
    soma.sync(path, hub)
    with pytest.raises(soma.catalog.ValidationError):
        soma.insert_rows(path, "items", [{"id": "bad", "updated_at": T0}])
    assert soma.execute_sql(path, "SELECT * FROM _sync_dirty") == []
    row = {"id": "remote", "name": "value", "updated_at": T0}
    hub.rows_push("items", list(row), [row])
    clock[0] = "2026-01-01T00:00:03.000Z"
    assert not soma.sync(path, hub)["rejected"]
    assert soma.execute_sql(path, "SELECT * FROM _sync_dirty") == []
    assert soma.sync(path, hub)["pushed"] == 0
    assert not soma.execute_sql(
        path, "SELECT * FROM sqlite_master WHERE type='trigger' AND name LIKE '_sync_dirty_%'"
    )
    assert not soma.execute_sql(path, "SELECT * FROM _schema_log WHERE ddl LIKE '%_sync_dirty%'")


def test_checkpoint_upgrade_recovers_preexisting_backdated_import(estate, clock):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    # Simulate an older writer and a persisted v2 checkpoint.
    with soma.connect(path) as conn:
        conn.execute(f"INSERT INTO items (id,updated_at) VALUES ('old','{T0}')")
        conn.execute("UPDATE _sync_state SET value='2' WHERE key='checkpoint_version'")
    assert not soma.sync(path, hub)["rejected"]
    assert "old" in ids(hub)


@pytest.mark.parametrize("deleted", [None, T0])
def test_equal_checkpoint_insert_is_not_lost(estate, clock, deleted):
    path, hub = estate
    boundary = state(path)["last_push"]
    soma.insert_rows(
        path,
        "items",
        [{"id": "boundary", "name": "value", "updated_at": boundary, "deleted_at": deleted}],
    )
    clock[0] = T1
    assert not soma.sync(path, hub)["rejected"]
    assert "boundary" in ids(hub)
    clock[0] = T2
    assert not soma.sync(path, hub)["rejected"]
    assert "boundary" in ids(hub)


def test_remote_future_revision_cannot_poison_push_checkpoint(estate, clock):
    path, hub = estate
    remote = {"id": "remote", "name": "future", "updated_at": FUTURE}
    assert not hub.rows_push("items", list(remote), [remote])["rejected"]
    clock[0] = T1
    soma.sync(path, hub)
    soma.sync(path, hub)
    soma.insert_rows(path, "items", [{"id": "local", "name": "normal"}])
    clock[0] = T2
    assert not soma.sync(path, hub)["rejected"]
    assert "local" in ids(hub)
    assert state(path)["last_push"] == T2


@pytest.mark.parametrize("poison", [T1, FUTURE])
@pytest.mark.parametrize("failure", [None, "interrupt", "reject"])
def test_existing_checkpoint_repair_retries_and_recovers_missed_rows(
    estate, clock, poison, failure, monkeypatch
):
    path, hub = estate
    # Model an already-used pre-fix database, including a consumed pull cursor.
    # The short poison is already in the past at repair time, so checking only
    # last_push > now would not recover this omission.
    soma.insert_rows(path, "items", [{"id": "missed-local", "name": "local"}])
    row = {"id": "missed-remote", "name": "remote", "updated_at": T0}
    hub.rows_push("items", list(row), [row])
    with soma.connect(path) as conn:
        conn.execute("DELETE FROM _sync_state")
        conn.executemany(
            "INSERT INTO _sync_state VALUES (?, ?)", [("last_push", poison), ("last_pull", T1)]
        )
    path = soma.init(path)  # Persisted state, not a fresh database success.
    before = state(path)
    clock[0] = T2
    original = hub.rows_push

    def failing(table, cols, rows, **kwargs):
        if table == "items":
            if failure == "interrupt":
                raise OSError("synthetic interruption")
            return {"upserted": 0, "rejected": [{"id": r["id"], "rule": "retry"} for r in rows]}
        return original(table, cols, rows, **kwargs)

    if failure:
        with monkeypatch.context() as m:
            m.setattr(hub, "rows_push", failing)
            if failure == "interrupt":
                with pytest.raises(OSError, match="synthetic"):
                    soma.sync(path, hub)
                kept = {k: v for k, v in state(path).items() if not k.startswith("recovery")}
                assert kept == before  # only resume progress was saved
            else:
                assert soma.sync(path, hub)["rejected"]
                assert state(path)["last_push"] == poison
                assert "checkpoint_version" not in state(path)
    assert not soma.sync(path, hub)["rejected"]
    assert "missed-local" in ids(hub)
    assert soma.execute_sql(path, "SELECT id FROM items WHERE id='missed-remote'")
    assert state(path)["last_push"] == T2


def test_writer_cannot_commit_below_a_snapshot_checkpoint(estate, clock, monkeypatch):
    path, hub = estate
    connect = soma.connect
    attempted = False
    blocked = []

    def traced_connect(p, manual_tx=False):
        conn = connect(p, manual_tx)

        def interleave(sql):
            nonlocal attempted
            if attempted or not sql.startswith('SELECT * FROM "items" WHERE updated_at'):
                return
            attempted = True
            # A writer arriving after the snapshot starts must wait. With a
            # plain read transaction WAL lets it commit a below-checkpoint row.
            with connect(path) as writer:
                writer.execute("PRAGMA busy_timeout=0")
                try:
                    writer.execute("INSERT INTO items(id,name) VALUES ('during','value')")
                except sqlite3.OperationalError as exc:
                    blocked.append(str(exc))
            clock[0] = T1

        if p == path:
            conn.set_trace_callback(interleave)
        return conn

    with monkeypatch.context() as m:
        m.setattr(soma, "connect", traced_connect)
        soma.sync(path, hub)
    assert attempted
    assert blocked == ["database is locked"]
    # Ordinary writes are available once the short snapshot finishes.
    soma.insert_rows(path, "items", [{"id": "after", "name": "value"}])
    clock[0] = T2
    soma.sync(path, hub)
    assert "after" in ids(hub)


class BoundHub(soma.LocalHub, soma.HttpHub):
    """Real local hub operations with the HTTP endpoint-binding identity."""

    def __init__(self, path, base):
        soma.LocalHub.__init__(self, path)
        self.base = base


def test_overlapping_first_sync_is_busy_before_second_hub_is_contacted(tmp_path):
    path = soma.init(tmp_path / "replica.db")
    soma.create_table(path, "items", ["name:text"])
    soma.insert_rows(path, "items", [{"id": "local", "name": "value"}])
    first = BoundHub(tmp_path / "first.db", "https://first.example")
    second = BoundHub(tmp_path / "second.db", "https://second.example")
    entered, release = threading.Event(), threading.Event()
    ready = first.ensure_ready

    def paused_ready():
        entered.set()
        assert release.wait(5)
        ready()

    first.ensure_ready = paused_ready
    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(soma.sync, path, first)
        try:
            assert entered.wait(5)
            with pytest.raises(RuntimeError, match="sync.*already|sync.*progress"):
                soma.sync(path, second)
            assert not second.path.exists()
            # The sync lock must not block local edits during network work.
            soma.insert_rows(path, "items", [{"id": "during", "name": "value"}])
        finally:
            release.set()
        assert not running.result(timeout=5)["rejected"]
    assert state(path)["hub_url"] == first.base
    assert ids(first) == {"local", "during"}
    with pytest.raises(ValueError, match="hub changed"):
        soma.sync(path, second)
    assert not second.path.exists()


def test_snapshot_waits_for_an_already_writing_transaction(estate, clock, monkeypatch):
    path, hub = estate
    connect = soma.connect
    snapshot_started = threading.Event()

    def traced_connect(p, manual_tx=False):
        conn = connect(p, manual_tx)
        if p == path:
            conn.set_trace_callback(
                lambda sql: snapshot_started.set() if sql == "BEGIN IMMEDIATE" else None
            )
        return conn

    with connect(path) as writer, ThreadPoolExecutor(max_workers=1) as pool:
        writer.execute("BEGIN IMMEDIATE")
        writer.execute("INSERT INTO items(id,name) VALUES ('pending','value')")
        with monkeypatch.context() as m:
            m.setattr(soma, "connect", traced_connect)
            running = pool.submit(soma.sync, path, hub)
            try:
                assert snapshot_started.wait(5)
                assert not running.done()
                clock[0] = T1
            finally:
                writer.commit()
            assert not running.result(timeout=5)["rejected"]
    assert "pending" in ids(hub)
    assert state(path)["last_push"] == T1


def test_sync_lock_releases_after_failure_and_is_per_database(estate, tmp_path, monkeypatch):
    path, hub = estate
    ready = hub.ensure_ready

    def failed_ready():
        # Another local database can sync while this one's round is active.
        other = soma.init(tmp_path / "other.db")
        soma.sync(other, soma.LocalHub(tmp_path / "other-hub.db"))
        raise OSError("synthetic failure")

    with monkeypatch.context() as m:
        m.setattr(hub, "ensure_ready", failed_ready)
        with pytest.raises(OSError, match="synthetic"):
            soma.sync(path, hub)
    assert hub.ensure_ready == ready
    assert not soma.sync(path, hub)["rejected"]


def test_sync_lock_is_cross_process_and_canonicalizes_symlinks(estate, tmp_path):
    import os
    import select
    import subprocess
    import sys
    from pathlib import Path

    path, hub = estate
    alias = tmp_path / "alias.db"
    alias.symlink_to(path)
    script = """
import sys
from pathlib import Path
import soma
class Paused(soma.LocalHub):
    def ensure_ready(self):
        print('ready', flush=True)
        sys.stdin.readline()
        super().ensure_ready()
soma.sync(Path(sys.argv[1]), Paused(Path(sys.argv[2])))
"""
    env = {**os.environ, "PYTHONPATH": str(Path(soma.__file__).parents[1])}
    proc = subprocess.Popen(
        [sys.executable, "-c", script, str(path), str(hub.path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert select.select([proc.stdout], [], [], 5)[0]
        assert proc.stdout.readline() == "ready\n"
        with pytest.raises(RuntimeError, match="sync.*already|sync.*progress"):
            soma.sync(alias, hub)
    finally:
        _, errors = proc.communicate("\n", timeout=5)
    assert proc.returncode == 0, errors
    assert not soma.sync(alias, hub)["rejected"]


def test_cursor_and_binding_commit_roll_back_together(tmp_path):
    path = soma.init(tmp_path / "replica.db")
    soma.create_table(path, "items", ["name:text"])
    soma.insert_rows(path, "items", [{"id": "a", "name": "value"}])
    hub = BoundHub(tmp_path / "hub.db", "https://hub.example")
    with soma.connect(path) as conn:
        conn.execute("""CREATE TRIGGER fail_state BEFORE INSERT ON _sync_state
            WHEN NEW.key = 'hub_url' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END""")
    before = state(path)
    with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
        soma.sync(path, hub)
    assert state(path) == before
    with soma.connect(path) as conn:
        conn.execute("DROP TRIGGER fail_state")
    assert not soma.sync(path, hub)["rejected"]
    assert state(path)["hub_url"] == hub.base
    assert ids(hub) == {"a"}


def test_table_created_before_snapshot_cannot_be_skipped_by_checkpoint(estate, clock, monkeypatch):
    path, hub = estate
    cursor = hub.marks

    def create_after_cursor(tables):
        result = cursor(tables)
        clock[0] = T1
        # SQL DDL is a supported writer too. It lands after schema replay and
        # table discovery, but before the snapshot's newer clock checkpoint.
        soma.execute_sql(path, soma.table_ddl("late", ["name:text"])[0])
        soma.insert_rows(path, "late", [{"id": "late-row", "name": "value"}])
        clock[0] = T2
        return result

    before = state(path)
    with monkeypatch.context() as m:
        m.setattr(hub, "marks", create_after_cursor)
        try:
            soma.sync(path, hub)
        except sqlite3.OperationalError as exc:
            # Discovering the new table may require retrying schema replay;
            # it must not advance a checkpoint past the unsent row.
            assert "no such table" in str(exc)
            assert state(path) == before
    assert not soma.sync(path, hub)["rejected"]
    assert hub.rows_pull("late", ["id"], "") == [{"id": "late-row"}]


def test_checkpoint_recovery_is_announced_once_across_restarts(estate, capsys):
    path, hub = estate
    with soma.connect(path) as conn:
        conn.execute("DELETE FROM _sync_state WHERE key='checkpoint_version'")
    capsys.readouterr()
    soma.sync(path, hub)
    messages = capsys.readouterr().err
    assert "sync checkpoint recovery: full pull" in messages
    assert "checkpoint recovery complete" in messages
    soma.sync(soma.init(path), hub)
    assert "checkpoint recovery" not in capsys.readouterr().err


@pytest.mark.parametrize("failure", [None, "reject", "interrupt"])
def test_observed_clock_rollback_recovers_even_if_clock_catches_up_before_retry(
    estate, clock, monkeypatch, failure
):
    path, hub = estate
    clock[0] = T2
    soma.sync(path, hub)
    assert state(path)["checkpoint_version"] == "3"
    clock[0] = T1  # A normal supported insert while the wall clock is behind.
    soma.insert_rows(path, "items", [{"id": "rollback", "name": "value"}])
    original = hub.rows_push

    def fail(table, columns, rows, **kwargs):
        if table == "items":
            if failure == "interrupt":
                raise OSError("synthetic interruption")
            return {"upserted": 0, "rejected": [{"id": r["id"], "rule": "retry"} for r in rows]}
        return original(table, columns, rows, **kwargs)

    with monkeypatch.context() as m:
        if failure:
            m.setattr(hub, "rows_push", fail)
        if failure == "interrupt":
            with pytest.raises(OSError, match="synthetic"):
                soma.sync(path, hub)
        else:
            out = soma.sync(path, hub)
            assert bool(out["rejected"]) == bool(failure)
    if failure:
        assert state(path)["last_push"] == T2
        assert state(path).get("checkpoint_version") != "3"
        clock[0] = T2
        assert not soma.sync(path, hub)["rejected"]
    assert "rollback" in ids(hub)
    assert state(path)["checkpoint_version"] == "3"


class Counting(soma.LocalHub):
    """A hub that records which tables a replica actually pulled."""

    def __init__(self, path):
        super().__init__(path)
        self.pulled = []

    def rows_pull(self, table, columns, since):
        self.pulled.append(table)
        return super().rows_pull(table, columns, since)


def test_quiet_round_pulls_only_tables_the_hub_reports_changed(tmp_path, clock):
    path = soma.init(tmp_path / "replica.db")
    other = soma.init(tmp_path / "other.db")
    for name in ("items", "notes", "places"):
        soma.create_table(path, name, ["name:text"])
    hub = Counting(tmp_path / "hub.db")
    soma.sync(path, hub)
    soma.sync(path, hub)  # the first round's cursor predates its own push; the second binds it
    soma.sync(other, hub)  # a second replica joins with the same schema
    clock[0] = T1
    soma.insert_rows(other, "notes", [{"id": "n1", "name": "from the other replica"}])
    soma.sync(other, hub)

    hub.pulled.clear()
    clock[0] = T2
    out = soma.sync(path, hub)
    assert out["pulled"] == 1
    assert "notes" in hub.pulled  # the changed table is pulled
    assert "items" not in hub.pulled and "places" not in hub.pulled  # quiet tables are not
    assert soma.execute_sql(path, "SELECT name FROM notes") == [{"name": "from the other replica"}]


def test_first_sync_and_hubs_without_marks_still_pull_everything(tmp_path, clock, monkeypatch):
    path = soma.init(tmp_path / "replica.db")
    for name in ("items", "notes"):
        soma.create_table(path, name, ["name:text"])
    hub = Counting(tmp_path / "hub.db")
    soma.sync(path, hub)  # first sync: no cursor yet
    assert {"items", "notes"} <= set(hub.pulled)

    soma.sync(path, hub)
    hub.pulled.clear()
    marks = hub.marks
    # an older hub answers with the maximum only
    monkeypatch.setattr(hub, "marks", lambda tables: (marks(tables)[0], None))
    soma.sync(path, hub)
    assert {"items", "notes"} <= set(hub.pulled)


T3 = "2026-01-01T00:00:03.000Z"


class Recording(soma.LocalHub):
    """Records pushes and pull-page requests; can fail one pull page once."""

    def __init__(self, path):
        super().__init__(path)
        self.pushed, self.calls, self.fail_page = [], [], None

    def rows_push(self, table, columns, rows, **kwargs):
        self.pushed += [(table, r["id"]) for r in rows]
        return super().rows_push(table, columns, rows, **kwargs)

    def rows_pull_pages(self, table, columns, since, after=None):
        self.calls.append((table, after))
        for n, page in enumerate(super().rows_pull_pages(table, columns, since, after)):
            if (table, n) == self.fail_page:
                self.fail_page = None
                raise OSError("synthetic page failure")
            yield page


def legacy_checkpoint(path):
    with soma.connect(path) as conn:
        conn.execute("UPDATE _sync_state SET value='2' WHERE key='checkpoint_version'")


def names(path, table="items"):
    rows = soma.execute_sql(path, f"SELECT id, name FROM {table}")
    return {r["id"]: r["name"] for r in rows}


def test_recovery_pushes_only_rows_the_hub_lacks_or_holds_older(tmp_path, clock):
    path = soma.init(tmp_path / "replica.db")
    soma.create_table(path, "items", ["name:text"])
    hub = Recording(tmp_path / "hub.db")
    soma.sync(path, hub)
    remote = [
        {"id": "same", "name": "hub", "updated_at": T1},
        {"id": "hub-newer", "name": "hub", "updated_at": T2},
        {"id": "local-newer", "name": "hub", "updated_at": T0},
    ]
    hub.rows_push("items", ["id", "name", "updated_at"], remote)
    # An older writer left rows without dirty receipts behind a pre-v3 checkpoint.
    with soma.connect(path) as conn:
        conn.executemany(
            "INSERT INTO items (id, name, updated_at) VALUES (?, 'local', ?)",
            [("same", T1), ("hub-newer", T1), ("local-newer", T2), ("local-only", T0)],
        )
    legacy_checkpoint(path)
    soma.insert_rows(path, "items", [{"id": "edited", "name": "local"}])
    hub.pushed.clear()
    clock[0] = T3
    assert not soma.sync(path, hub)["rejected"]
    assert sorted(hub.pushed) == [
        ("items", "edited"),
        ("items", "local-newer"),
        ("items", "local-only"),
    ]
    assert names(hub.path) == {
        "same": "hub",
        "hub-newer": "hub",
        "local-newer": "local",
        "local-only": "local",
        "edited": "local",
    }
    assert names(path)["hub-newer"] == "hub"
    assert state(path)["checkpoint_version"] == "3"


def test_interrupted_recovery_resumes_at_the_failed_page(tmp_path, clock, monkeypatch):
    monkeypatch.setattr(soma, "CHUNK", 2)
    path = soma.init(tmp_path / "replica.db")
    other = soma.init(tmp_path / "other.db")
    for name in ("alpha", "items"):
        soma.create_table(path, name, ["name:text"])
    hub = Recording(tmp_path / "hub.db")
    soma.sync(path, hub)
    soma.insert_rows(path, "items", [{"id": f"i{n}", "name": "v"} for n in range(6)])
    soma.sync(path, hub)
    soma.sync(other, hub)
    legacy_checkpoint(path)

    hub.fail_page = ("items", 1)
    with pytest.raises(OSError, match="synthetic page failure"):
        soma.sync(path, hub)
    # Between attempts: another replica writes to a table recovery already
    # verified (two arrivals, so a fresh cursor would skip the first), and so
    # does this replica.
    clock[0] = T1
    soma.insert_rows(other, "alpha", [{"id": "remote-late", "name": "v"}])
    soma.sync(other, hub)
    clock[0] = T2
    soma.insert_rows(other, "alpha", [{"id": "remote-later", "name": "v"}])
    soma.sync(other, hub)
    soma.insert_rows(path, "alpha", [{"id": "local-late", "name": "v"}])

    hub.calls.clear()
    clock[0] = T3
    assert not soma.sync(path, hub)["rejected"]
    assert hub.calls[0] == ("items", "i1")  # resumes after the last completed page
    assert {t for t, _ in hub.calls} <= {"items", "history"}
    assert state(path)["checkpoint_version"] == "3"
    assert not [k for k in state(path) if k.startswith("recovery")]
    assert "local-late" in names(hub.path, "alpha")
    assert not soma.sync(path, hub)["rejected"]
    assert {"remote-late", "remote-later"} <= set(names(path, "alpha"))
    assert set(names(path)) == {f"i{n}" for n in range(6)}


def test_rejected_recovery_rescans_the_hub_on_retry(estate, clock, monkeypatch):
    path, hub = estate
    with soma.connect(path) as conn:
        conn.execute(f"INSERT INTO items (id, updated_at) VALUES ('missed', '{T0}')")
    legacy_checkpoint(path)
    original = hub.rows_push

    def rejecting(table, cols, rows, **kwargs):
        if table == "items":
            return {"upserted": 0, "rejected": [{"id": r["id"], "rule": "retry"} for r in rows]}
        return original(table, cols, rows, **kwargs)

    clock[0] = T1  # the missed row predates recovery: only the hub comparison finds it
    with monkeypatch.context() as m:
        m.setattr(hub, "rows_push", rejecting)
        assert soma.sync(path, hub)["rejected"]
    assert state(path)["checkpoint_version"] != "3"
    clock[0] = T2
    assert not soma.sync(path, hub)["rejected"]
    assert "missed" in ids(hub)
    assert state(path)["checkpoint_version"] == "3"
