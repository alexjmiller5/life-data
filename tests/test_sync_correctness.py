"""Deterministic sync regressions. Every database and endpoint is synthetic."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

import life_data as life

T0 = "2026-01-01T00:00:00.000Z"
T1 = "2026-01-01T00:00:01.000Z"
T2 = "2026-01-01T00:00:02.000Z"
FUTURE = "2099-01-01T00:00:00.000Z"


@pytest.fixture
def clock(monkeypatch):
    ticks = [T0]
    connect = life.connect

    def clocked_connect(path, manual_tx=False):
        conn = connect(path, manual_tx)
        conn.create_function("strftime", 2, lambda *_: ticks[0])
        return conn

    monkeypatch.setattr(life, "connect", clocked_connect)
    return ticks


@pytest.fixture
def estate(tmp_path, clock):
    path = life.init(tmp_path / "replica.db")
    life.create_table(path, "items", ["name:text"])
    hub = life.LocalHub(tmp_path / "hub.db")
    life.sync(path, hub)
    return path, hub


def state(path):
    return {r["key"]: r["value"] for r in life.execute_sql(path, "SELECT * FROM _sync_state")}


def ids(hub):
    return {r["id"] for r in hub.rows_pull("items", ["id"], "")}


@pytest.mark.parametrize("deleted", [None, T0])
def test_equal_checkpoint_insert_is_not_lost(estate, clock, deleted):
    path, hub = estate
    boundary = state(path)["last_push"]
    life.insert_rows(
        path,
        "items",
        [{"id": "boundary", "name": "value", "updated_at": boundary, "deleted_at": deleted}],
    )
    clock[0] = T1
    assert not life.sync(path, hub)["rejected"]
    assert "boundary" in ids(hub)
    clock[0] = T2
    assert not life.sync(path, hub)["rejected"]
    assert "boundary" in ids(hub)


def test_remote_future_revision_cannot_poison_push_checkpoint(estate, clock):
    path, hub = estate
    remote = {"id": "remote", "name": "future", "updated_at": FUTURE}
    assert not hub.rows_push("items", list(remote), [remote])["rejected"]
    clock[0] = T1
    life.sync(path, hub)
    life.sync(path, hub)
    life.insert_rows(path, "items", [{"id": "local", "name": "normal"}])
    clock[0] = T2
    assert not life.sync(path, hub)["rejected"]
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
    life.insert_rows(path, "items", [{"id": "missed-local", "name": "local"}])
    row = {"id": "missed-remote", "name": "remote", "updated_at": T0}
    hub.rows_push("items", list(row), [row])
    with life.connect(path) as conn:
        conn.execute("DELETE FROM _sync_state")
        conn.executemany(
            "INSERT INTO _sync_state VALUES (?, ?)", [("last_push", poison), ("last_pull", T1)]
        )
    path = life.init(path)  # Persisted state, not a fresh database success.
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
                    life.sync(path, hub)
                assert state(path) == before
            else:
                assert life.sync(path, hub)["rejected"]
                assert state(path)["last_push"] == poison
                assert "checkpoint_version" not in state(path)
    assert not life.sync(path, hub)["rejected"]
    assert "missed-local" in ids(hub)
    assert life.execute_sql(path, "SELECT id FROM items WHERE id='missed-remote'")
    assert state(path)["last_push"] == T2


def test_writer_cannot_commit_below_a_snapshot_checkpoint(estate, clock, monkeypatch):
    path, hub = estate
    connect = life.connect
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
        m.setattr(life, "connect", traced_connect)
        life.sync(path, hub)
    assert attempted
    assert blocked == ["database is locked"]
    # Ordinary writes are available once the short snapshot finishes.
    life.insert_rows(path, "items", [{"id": "after", "name": "value"}])
    clock[0] = T2
    life.sync(path, hub)
    assert "after" in ids(hub)


class BoundHub(life.LocalHub, life.HttpHub):
    """Real local hub operations with the HTTP endpoint-binding identity."""

    def __init__(self, path, base):
        life.LocalHub.__init__(self, path)
        self.base = base


def test_overlapping_first_sync_is_busy_before_second_hub_is_contacted(tmp_path):
    path = life.init(tmp_path / "replica.db")
    life.create_table(path, "items", ["name:text"])
    life.insert_rows(path, "items", [{"id": "local", "name": "value"}])
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
        running = pool.submit(life.sync, path, first)
        try:
            assert entered.wait(5)
            with pytest.raises(RuntimeError, match="sync.*already|sync.*progress"):
                life.sync(path, second)
            assert not second.path.exists()
            # The sync lock must not block local edits during network work.
            life.insert_rows(path, "items", [{"id": "during", "name": "value"}])
        finally:
            release.set()
        assert not running.result(timeout=5)["rejected"]
    assert state(path)["hub_url"] == first.base
    assert ids(first) == {"local", "during"}
    with pytest.raises(ValueError, match="hub changed"):
        life.sync(path, second)
    assert not second.path.exists()


def test_snapshot_waits_for_an_already_writing_transaction(estate, clock, monkeypatch):
    path, hub = estate
    connect = life.connect
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
            m.setattr(life, "connect", traced_connect)
            running = pool.submit(life.sync, path, hub)
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
        other = life.init(tmp_path / "other.db")
        life.sync(other, life.LocalHub(tmp_path / "other-hub.db"))
        raise OSError("synthetic failure")

    with monkeypatch.context() as m:
        m.setattr(hub, "ensure_ready", failed_ready)
        with pytest.raises(OSError, match="synthetic"):
            life.sync(path, hub)
    assert hub.ensure_ready == ready
    assert not life.sync(path, hub)["rejected"]


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
import life_data as life
class Paused(life.LocalHub):
    def ensure_ready(self):
        print('ready', flush=True)
        sys.stdin.readline()
        super().ensure_ready()
life.sync(Path(sys.argv[1]), Paused(Path(sys.argv[2])))
"""
    env = {**os.environ, "PYTHONPATH": str(Path(life.__file__).parents[1])}
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
            life.sync(alias, hub)
    finally:
        _, errors = proc.communicate("\n", timeout=5)
    assert proc.returncode == 0, errors
    assert not life.sync(alias, hub)["rejected"]


def test_cursor_and_binding_commit_roll_back_together(tmp_path):
    path = life.init(tmp_path / "replica.db")
    life.create_table(path, "items", ["name:text"])
    life.insert_rows(path, "items", [{"id": "a", "name": "value"}])
    hub = BoundHub(tmp_path / "hub.db", "https://hub.example")
    with life.connect(path) as conn:
        conn.execute("""CREATE TRIGGER fail_state BEFORE INSERT ON _sync_state
            WHEN NEW.key = 'hub_url' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END""")
    before = state(path)
    with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
        life.sync(path, hub)
    assert state(path) == before
    with life.connect(path) as conn:
        conn.execute("DROP TRIGGER fail_state")
    assert not life.sync(path, hub)["rejected"]
    assert state(path)["hub_url"] == hub.base
    assert ids(hub) == {"a"}


def test_table_created_before_snapshot_cannot_be_skipped_by_checkpoint(estate, clock, monkeypatch):
    path, hub = estate
    cursor = hub.cursor

    def create_after_cursor(tables):
        result = cursor(tables)
        clock[0] = T1
        # SQL DDL is a supported writer too. It lands after schema replay and
        # table discovery, but before the snapshot's newer clock checkpoint.
        life.execute_sql(path, life.table_ddl("late", ["name:text"])[0])
        life.insert_rows(path, "late", [{"id": "late-row", "name": "value"}])
        clock[0] = T2
        return result

    before = state(path)
    with monkeypatch.context() as m:
        m.setattr(hub, "cursor", create_after_cursor)
        try:
            life.sync(path, hub)
        except sqlite3.OperationalError as exc:
            # Discovering the new table may require retrying schema replay;
            # it must not advance a checkpoint past the unsent row.
            assert "no such table" in str(exc)
            assert state(path) == before
    assert not life.sync(path, hub)["rejected"]
    assert hub.rows_pull("late", ["id"], "") == [{"id": "late-row"}]


def test_checkpoint_recovery_is_announced_once_across_restarts(estate, capsys):
    path, hub = estate
    with life.connect(path) as conn:
        conn.execute("DELETE FROM _sync_state WHERE key='checkpoint_version'")
    capsys.readouterr()
    life.sync(path, hub)
    messages = capsys.readouterr().err
    assert "full pull and push" in messages
    assert "checkpoint recovery complete" in messages
    life.sync(life.init(path), hub)
    assert "checkpoint recovery" not in capsys.readouterr().err


@pytest.mark.parametrize("failure", [None, "reject", "interrupt"])
def test_observed_clock_rollback_recovers_even_if_clock_catches_up_before_retry(
    estate, clock, monkeypatch, failure
):
    path, hub = estate
    clock[0] = T2
    life.sync(path, hub)
    assert state(path)["checkpoint_version"] == "2"
    clock[0] = T1  # A normal supported insert while the wall clock is behind.
    life.insert_rows(path, "items", [{"id": "rollback", "name": "value"}])
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
                life.sync(path, hub)
        else:
            out = life.sync(path, hub)
            assert bool(out["rejected"]) == bool(failure)
    if failure:
        assert state(path)["last_push"] == T2
        assert state(path).get("checkpoint_version") != "2"
        clock[0] = T2
        assert not life.sync(path, hub)["rejected"]
    assert "rollback" in ids(hub)
    assert state(path)["checkpoint_version"] == "2"
