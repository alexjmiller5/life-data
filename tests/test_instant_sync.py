"""Instant sync: remote edits start a round through the hub's change long poll,
failed rounds retry within two minutes, and a quiet round stays cheap."""

import itertools
import json
import queue
import sqlite3
import threading
import time
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import soma
from soma import (
    HttpHub,
    LocalHub,
    RemoteChanges,
    create_table,
    execute_sql,
    init,
    insert_rows,
    pending_local_writes,
    sync,
    watch,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "soma.db")


@pytest.fixture()
def hub(tmp_path):
    return LocalHub(tmp_path / "hub.db")


# --- the long poll -------------------------------------------------------------


def test_http_hub_long_polls_the_change_sequence():
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers["Authorization"]))
            body = json.dumps({"seq": 9}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        hub = HttpHub(f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer t"})
        assert hub.changes(4, 25) == 9
        assert hub.changes(None, 0) == 9
    finally:
        server.shutdown()
    assert seen == [("/v1/changes?wait=25&since=4", "Bearer t"), ("/v1/changes?wait=0", "Bearer t")]


class QueueHub:
    """changes() answers from a queue, as a held long poll would."""

    def __init__(self):
        self.calls, self.answers = [], queue.Queue()

    def changes(self, since, wait):
        self.calls.append((since, wait))
        answer = self.answers.get(timeout=5)
        if isinstance(answer, Exception):
            raise answer
        return answer


def eventually(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_listener_signals_each_new_sequence_once_and_reports_a_dead_channel():
    hub = QueueHub()
    remote = RemoteChanges(hub, retry=0.01)
    remote.start()
    try:
        hub.answers.put(3)  # the first answer is news: a round must follow it
        assert eventually(remote.take)
        assert remote.live and not remote.take()
        hub.answers.put(3)  # a timed-out poll changes nothing
        assert eventually(lambda: len(hub.calls) == 3)
        assert not remote.take()
        hub.answers.put(4)
        assert eventually(remote.take)
        hub.answers.put(RuntimeError("hub unreachable"))
        assert eventually(lambda: not remote.live)
        hub.answers.put(5)  # changes made while the channel was down are news too
        assert eventually(remote.take)
        assert remote.live
    finally:
        remote.stop()
        hub.answers.put(5)
    assert hub.calls[:3] == [(None, 25), (3, 25), (3, 25)]
    assert (4, 25) in hub.calls


def test_listener_logs_only_when_the_channel_goes_live_or_down(capsys):
    hub = QueueHub()
    remote = RemoteChanges(hub, retry=0.01)
    remote.start()
    try:
        for answer in (1, 1, RuntimeError("hub HTTP 501"), RuntimeError("again"), 1):
            hub.answers.put(answer)
        assert eventually(lambda: len(hub.calls) == 6)
    finally:
        remote.stop()
        hub.answers.put(1)
    assert capsys.readouterr().err.splitlines() == [
        "change signal live: remote edits sync as they land",
        "change signal unavailable (RuntimeError); polling every 0.01 s",
        "change signal live: remote edits sync as they land",
    ]


# --- the loops, on a fake clock --------------------------------------------------


class FakeListener:
    """Stands in for RemoteChanges: signals at chosen clock times."""

    def __init__(self, clock, at, live=True):
        self.clock, self.at, self.live, self.stopped = clock, list(at), live, False
        self.spins = 0

    def start(self):
        pass

    def stop(self):
        self.stopped = True

    def take(self):
        if self.at and self.clock[0] >= self.at[0]:
            self.at.pop(0)
            return True
        return False

    def wait(self, seconds):
        # Event.wait: returns at a signal due within the timeout, else at the timeout.
        if self.at and self.at[0] < self.clock[0] + seconds:
            if self.at[0] <= self.clock[0]:
                self.spins += 1
                assert self.spins < 50, "the loop waits again on a signal it never took"
            soma.time.sleep(max(0.0, self.at[0] - self.clock[0]))
            return True
        soma.time.sleep(seconds)
        return False


@pytest.fixture()
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(soma.time, "monotonic", lambda: now[0])
    return now


def stop_at(monkeypatch, clock, until):
    def sleep(seconds):
        clock[0] += seconds
        if clock[0] > until:
            raise KeyboardInterrupt

    monkeypatch.setattr(soma.time, "sleep", sleep)


def gaps(times):
    return [round(b - a) for a, b in itertools.pairwise(times)]


class SignalHub:
    def changes(self, since, wait):  # only its presence matters to the loops
        raise AssertionError("the fake listener answers instead")


QUIET = {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}


def test_watch_syncs_on_a_remote_signal_and_drops_the_fixed_poll(db, clock, monkeypatch, capsys):
    rounds = []
    monkeypatch.setattr(soma, "sync", lambda *_: rounds.append(clock[0]) or QUIET)
    listener = FakeListener(clock, [1007, 1050])
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: listener)
    stop_at(monkeypatch, clock, 1000 + 50 + soma.SAFETY_SECONDS + 10)
    with pytest.raises(KeyboardInterrupt):
        watch(db, SignalHub(), poll_seconds=30)
    assert [r - 1000 for r in rounds] == [0, 7, 50, 50 + soma.SAFETY_SECONDS]
    assert listener.stopped


def test_watch_starts_a_round_the_moment_the_hub_signals(db, clock, monkeypatch):
    rounds = []
    monkeypatch.setattr(soma, "sync", lambda *_: rounds.append(clock[0]) or QUIET)
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: FakeListener(clock, [1007.3]))
    stop_at(monkeypatch, clock, 1010)
    with pytest.raises(KeyboardInterrupt):
        watch(db, SignalHub(), poll_seconds=30)
    # not at the next whole-second tick (1008): a replica waits on the signal itself
    assert [round(r - 1000, 1) for r in rounds] == [0, 7.3]


def test_watch_falls_back_to_the_poll_while_the_channel_is_down(db, clock, monkeypatch):
    rounds = []
    monkeypatch.setattr(soma, "sync", lambda *_: rounds.append(clock[0]) or QUIET)
    monkeypatch.setattr(
        soma, "RemoteChanges", lambda hub, retry: FakeListener(clock, [], live=False)
    )
    stop_at(monkeypatch, clock, 1095)
    with pytest.raises(KeyboardInterrupt):
        watch(db, SignalHub(), poll_seconds=30)
    assert gaps(rounds) == [30, 30, 30]


def run_runner(tmp_path, monkeypatch, clock, until, sync_result, hub=None):
    """Drive the launchd runner on the fake clock; returns each attempt's time."""
    from soma import background

    monkeypatch.setenv("SOMA_HUB_TOKEN", "synthetic")
    background.write_json(tmp_path / "background.json", {"enabled": True})
    monkeypatch.setattr(soma, "hub_from_config", lambda _: hub or object())
    attempts = []

    def fake_sync(*_):
        attempts.append(clock[0])
        return sync_result(len(attempts))

    monkeypatch.setattr(soma, "sync", fake_sync)
    stop_at(monkeypatch, clock, until)
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    return attempts


def raise_(exc):
    raise exc


def test_failed_rounds_back_off_to_at_most_two_minutes(tmp_path, monkeypatch, clock):
    attempts = run_runner(
        tmp_path,
        monkeypatch,
        clock,
        1000 + 800,
        lambda _: raise_(RuntimeError("hub unreachable")),
    )
    assert gaps(attempts)[:6] == [15, 30, 60, 120, 120, 120]


def test_success_resets_the_backoff(tmp_path, monkeypatch, clock):
    outcomes = {3: QUIET}
    attempts = run_runner(
        tmp_path,
        monkeypatch,
        clock,
        1000 + 120,
        lambda n: outcomes.get(n) or raise_(RuntimeError("hub unreachable")),
    )
    # fail, fail, succeed, next poll fails, and the retry starts small again
    assert gaps(attempts)[:4] == [15, 30, 30, 15]


def test_a_locked_database_retries_in_seconds(tmp_path, monkeypatch, clock):
    attempts = run_runner(
        tmp_path,
        monkeypatch,
        clock,
        1000 + 30,
        lambda _: raise_(sqlite3.OperationalError("database is locked")),
    )
    assert set(gaps(attempts)) == {5}


def test_credential_failures_keep_the_long_backoff(tmp_path, monkeypatch, clock):
    from soma import background

    reads = []

    def credential(*_):
        reads.append(clock[0])
        raise RuntimeError("credential command failed")

    monkeypatch.setattr(background, "_credential", credential)
    run_runner(tmp_path, monkeypatch, clock, 1000 + 1000, lambda _: QUIET)
    # a command-backed credential has a finite budget: never every two minutes
    assert gaps(reads) == [15, 30, 60, 120, 240, 480]


def test_unauthorized_hub_rereads_the_credential_on_the_long_backoff(tmp_path, monkeypatch, clock):
    denied = RuntimeError("hub HTTP 401")
    denied.__cause__ = urllib.error.HTTPError("https://hub", 401, "no", {}, None)
    attempts = run_runner(tmp_path, monkeypatch, clock, 1000 + 500, lambda _: raise_(denied))
    assert gaps(attempts) == [15, 30, 60, 120, 240]


def test_runner_syncs_on_a_remote_signal_and_polls_only_as_a_safety_net(
    tmp_path, monkeypatch, clock
):
    listener = FakeListener(clock, [1007])
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: listener)
    attempts = run_runner(
        tmp_path,
        monkeypatch,
        clock,
        1000 + soma.SAFETY_SECONDS + 20,
        lambda _: QUIET,
        hub=SignalHub(),
    )
    assert [a - 1000 for a in attempts] == [0, 7, 7 + soma.SAFETY_SECONDS]


def test_runner_starts_a_round_the_moment_the_hub_signals(tmp_path, monkeypatch, clock):
    listener = FakeListener(clock, [1007.3])
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: listener)
    attempts = run_runner(tmp_path, monkeypatch, clock, 1010, lambda _: QUIET, hub=SignalHub())
    assert [round(a - 1000, 1) for a in attempts] == [0, 7.3]


def test_runner_never_spins_on_a_signal_a_failing_iteration_cannot_take(
    tmp_path, monkeypatch, clock
):
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: FakeListener(clock, [1003.5]))
    real, ticks = soma.db_changed, []

    def failing_after_the_first_round(path, fingerprint):
        ticks.append(clock[0])
        if clock[0] >= 1002:
            raise sqlite3.OperationalError("disk I/O error")
        return real(path, fingerprint)

    monkeypatch.setattr(soma, "db_changed", failing_after_the_first_round)
    run_runner(tmp_path, monkeypatch, clock, 1010, lambda _: QUIET, hub=SignalHub())
    assert len(ticks) <= 12  # one iteration per second, never one per pending signal


def test_runner_polls_while_the_change_channel_is_down(tmp_path, monkeypatch, clock):
    monkeypatch.setattr(
        soma, "RemoteChanges", lambda hub, retry: FakeListener(clock, [], live=False)
    )
    attempts = run_runner(tmp_path, monkeypatch, clock, 1000 + 95, lambda _: QUIET, SignalHub())
    assert gaps(attempts) == [30, 30, 30]


def test_watch_runs_again_at_once_when_a_write_landed_during_its_round(db, clock, monkeypatch):
    rounds = []
    monkeypatch.setattr(soma, "sync", lambda *_: rounds.append(clock[0]) or QUIET)
    answers = iter([True])  # the first round missed a write; the second did not
    monkeypatch.setattr(soma, "pending_local_writes", lambda _: next(answers, False))
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: FakeListener(clock, []))
    stop_at(monkeypatch, clock, 1010)
    with pytest.raises(KeyboardInterrupt):
        watch(db, SignalHub(), poll_seconds=30)
    assert [r - 1000 for r in rounds] == [0, 1]


def test_runner_runs_again_at_once_when_a_write_landed_during_its_round(
    tmp_path, monkeypatch, clock
):
    answers = iter([True])
    monkeypatch.setattr(soma, "pending_local_writes", lambda _: next(answers, False))
    monkeypatch.setattr(soma, "RemoteChanges", lambda hub, retry: FakeListener(clock, []))
    attempts = run_runner(tmp_path, monkeypatch, clock, 1010, lambda _: QUIET, SignalHub())
    assert [a - 1000 for a in attempts] == [0, 1]


# --- a cheap quiet round -----------------------------------------------------------


def test_writes_made_while_a_round_ran_are_pending_until_the_next_round(db, hub):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"name": "Ada"}])
    sync(db, hub)
    assert not pending_local_writes(db)
    execute_sql(db, "UPDATE people SET name = 'Grace'")  # a `soma sql` write
    assert pending_local_writes(db)
    sync(db, hub)
    assert not pending_local_writes(db)
    with sqlite3.connect(db) as other:  # a writer without dirty receipts (Iris)
        other.execute(
            "UPDATE people SET name = 'Lin', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
        )
    assert pending_local_writes(db)
    # The hub logs this edit's history itself, stamped just after our snapshot
    # and pulled back in the same round: one more round, then quiet.
    sync(db, hub)
    sync(db, hub)
    assert not pending_local_writes(db)


def test_a_backdated_import_is_pending_through_its_dirty_receipt(db, hub):
    create_table(db, "people", ["name:text"])
    sync(db, hub)
    old = {"id": "imported", "name": "Ada", "updated_at": "2001-01-01T00:00:00.000Z"}
    insert_rows(db, "people", [old])  # the source's own stamp, far behind the cursor
    assert pending_local_writes(db)


def test_a_future_stamped_row_never_keeps_rounds_running(db, hub):
    create_table(db, "people", ["name:text"])
    sync(db, hub)
    future = {"id": "f", "name": "Skewed", "updated_at": "2999-01-01T00:00:00.000Z"}
    hub.rows_push("people", list(future), [future])
    sync(db, hub)
    assert execute_sql(db, "SELECT name FROM people") == [{"name": "Skewed"}]
    assert not pending_local_writes(db)


def test_a_replica_that_never_synced_has_nothing_pending_to_report(db):
    assert not pending_local_writes(db)


class CountingHub(LocalHub):
    """Counts the replica's whole-log pulls (not LocalHub's own, inside a push)."""

    def __init__(self, path):
        super().__init__(path)
        self.schema_pulls, self.pushing = 0, False

    def schema_pull(self):
        self.schema_pulls += not self.pushing
        return super().schema_pull()

    def schema_push(self, entries):
        self.pushing = True
        try:
            return super().schema_push(entries)
        finally:
            self.pushing = False


def settle(path, hub):
    """Rounds until one needs no schema log (each side's own replay settles once)."""
    for _ in range(4):
        before = hub.schema_pulls
        sync(path, hub)
        if hub.schema_pulls == before:
            return
    raise AssertionError("schema log never settled")


def test_quiet_rounds_skip_the_schema_log_until_either_side_changes(tmp_path):
    hub = CountingHub(tmp_path / "hub.db")
    a, b = init(tmp_path / "a" / "soma.db"), init(tmp_path / "b" / "soma.db")
    create_table(a, "people", ["name:text"])
    settle(a, hub)
    settle(b, hub)
    before = hub.schema_pulls
    sync(a, hub)
    sync(b, hub)
    assert hub.schema_pulls == before

    execute_sql(b, "ALTER TABLE people ADD COLUMN bio TEXT")  # a local change...
    sync(b, hub)
    assert hub.schema_pulls == before + 1
    sync(a, hub)  # ...and a remote one both take the full path
    assert hub.schema_pulls == before + 2
    assert "bio" in {r["name"] for r in execute_sql(a, "PRAGMA table_info(people)")}


def test_push_candidates_come_from_an_unlogged_updated_at_index(db, hub):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"name": "Ada"}])
    sync(db, hub)
    indexes = execute_sql(
        db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'people'"
    )
    assert "people_updated_at" in {r["name"] for r in indexes}
    logged = execute_sql(db, "SELECT ddl FROM _schema_log WHERE ddl LIKE '%INDEX%'")
    assert logged == []
    plan = execute_sql(
        db,
        "EXPLAIN QUERY PLAN SELECT * FROM people WHERE updated_at >= '' OR id IN "
        "(SELECT row_id FROM _sync_dirty WHERE tbl='people')",
    )
    assert not any(r["detail"].startswith("SCAN people") for r in plan), plan


def test_pulled_rows_commit_chunk_by_chunk(tmp_path, hub, monkeypatch):
    a, b = init(tmp_path / "a" / "soma.db"), init(tmp_path / "b" / "soma.db")
    create_table(a, "people", ["name:text"])
    sync(a, hub)
    sync(b, hub)  # past the first-sync recovery, which pages anyway
    insert_rows(a, "people", [{"name": f"p{i}"} for i in range(2 * soma.CHUNK + 50)])
    sync(a, hub)

    probes = []
    upsert_sql = soma._upsert_sql

    def probe(table, columns):
        # Another writer (a `soma sql` edit) must get in between chunks.
        other = sqlite3.connect(b, timeout=0)
        try:
            other.execute("BEGIN IMMEDIATE")
            other.execute("ROLLBACK")
            probes.append((table, True))
        except sqlite3.OperationalError:
            probes.append((table, False))
        finally:
            other.close()
        return upsert_sql(table, columns)

    monkeypatch.setattr(soma, "_upsert_sql", probe)
    sync(b, hub)
    people = [ok for table, ok in probes if table == "people"]
    assert len(people) == 3 and all(people), probes
