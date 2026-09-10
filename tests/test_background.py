"""Exercise the installed CLI shape and runner against a real HTTP hub."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from test_core import _serve

from life_data import execute_sql


def cli(data, *args, **kwargs):
    env = {
        **os.environ,
        "LIFE_DATA_DIR": str(data),
        "PYTHONPATH": os.environ.get("LIFE_TEST_SRC", str(Path("src").resolve())),
    }
    env.pop("LIFE_HUB_TOKEN", None)
    env.pop("LIFE_HUB_URL", None)
    return subprocess.run(
        [sys.executable, "-c", "from life_data import main; raise SystemExit(main())", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        **kwargs,
    )


def wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(0.05)
    raise AssertionError("background state did not converge")


def test_background_is_off_and_inspectable_without_credentials(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"token_cmd": "exit 99"}))
    result = cli(tmp_path, "background", "status")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["enabled"] is False
    assert json.loads(result.stdout)["running"] is False
    assert cli(tmp_path, "background", "disable").returncode == 0


def test_cli_toggle_controls_real_runner_and_persists_across_restart(tmp_path):
    data = tmp_path / "client"
    data.mkdir()
    server = _serve(tmp_path / "hub.db")
    cfg = {"hub_url": f"http://127.0.0.1:{server.server_port}", "token_cmd": "exit 99"}
    (data / "config.json").write_text(json.dumps(cfg))
    runner = None
    try:

        def start():
            env = {
                **os.environ,
                "LIFE_DATA_DIR": str(data),
                "PYTHONPATH": os.environ.get("LIFE_TEST_SRC", str(Path("src").resolve())),
            }
            env.pop("LIFE_HUB_TOKEN", None)
            env.pop("LIFE_HUB_URL", None)
            return subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "from life_data import main; raise SystemExit(main())",
                    "background",
                    "run",
                    "--poll",
                    "1",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

        assert cli(data, "init").returncode == 0
        runner = start()
        assert cli(data, "table", "create", "items", "name:text").returncode == 0
        assert cli(data, "insert", "items", input='[{"id":"one","name":"First"}]').returncode == 0
        assert (
            cli(data, "background", "enable", "--token-command", "printf testtoken").returncode == 0
        )
        wait_for(lambda: json.loads(cli(data, "background", "status").stdout).get("last_success"))
        assert execute_sql(tmp_path / "hub.db", "SELECT name FROM items")[0]["name"] == "First"
        status = json.loads(cli(data, "background", "status").stdout)
        assert status["enabled"] and status["running"] and status["last_error"] is None
        duplicate = cli(data, "background", "run")
        assert duplicate.returncode == 1 and "already running" in duplicate.stderr
        if sys.platform == "darwin":
            import signal

            runner.send_signal(signal.SIGSTOP)
            try:
                wait_for(
                    lambda: not json.loads(cli(data, "background", "status").stdout)["running"]
                )
            finally:
                runner.send_signal(signal.SIGCONT)
        assert "testtoken" not in cli(data, "background", "status").stdout
        assert cli(data, "background", "disable").returncode == 0
        wait_for(
            lambda: json.loads(cli(data, "background", "status").stdout).get("state") == "disabled"
        )
        runner.terminate()
        runner.communicate(timeout=5)
        runner = start()
        wait_for(lambda: json.loads(cli(data, "background", "status").stdout).get("running"))
        assert cli(data, "insert", "items", input='[{"id":"two","name":"Second"}]').returncode == 0
        time.sleep(1.2)
        assert execute_sql(tmp_path / "hub.db", "SELECT count(*) AS n FROM items")[0]["n"] == 1
        assert json.loads(cli(data, "background", "status").stdout)["enabled"] is False
        assert cli(data, "background", "enable").returncode == 0
        wait_for(
            lambda: execute_sql(tmp_path / "hub.db", "SELECT count(*) AS n FROM items")[0]["n"] == 2
        )
    finally:
        if runner:
            runner.terminate()
            runner.communicate(timeout=5)
        server.shutdown()


def test_disabled_runner_never_reads_credentials_and_errors_back_off(tmp_path, monkeypatch):
    from life_data import background

    (tmp_path / "config.json").write_text(json.dumps({"token_cmd": "exit 99"}))
    # Break this by resolving credentials before checking enabled, or by
    # retrying on every tick: the command marker will appear too early/often.
    marker = tmp_path / "reads"
    command = f"printf x >> '{marker}'; printf sensitive-detail >&2; exit 1"
    background.write_json(tmp_path / "background.json", {"enabled": False, "token_cmd": command})
    ticks = []

    def sleep(_):
        ticks.append(1)
        if len(ticks) == 1:
            assert not marker.exists()
            background.write_json(
                tmp_path / "background.json", {"enabled": True, "token_cmd": command}
            )
        elif len(ticks) == 3:
            raise KeyboardInterrupt

    monkeypatch.setattr(background.time, "sleep", sleep)
    import pytest

    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    assert marker.read_text() == "x"
    saved = (tmp_path / "background-status.json").read_text()
    assert "sensitive-detail" not in saved
    assert background.status(tmp_path)["last_error"] == "credential command failed"
    assert background.status(tmp_path)["running"] is False


def test_keychain_enable_stores_no_plaintext_and_status_does_not_unlock(
    tmp_path, monkeypatch, capsys
):
    import io

    from life_data import credentials, load_config, main

    saved = {}
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    monkeypatch.delenv("LIFE_HUB_URL", raising=False)
    monkeypatch.setattr(
        credentials, "store_token", lambda account, token: saved.update({account: token})
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("private-test-value\n"))
    assert main(["background", "enable", "--token-stdin", "--hub-url", "https://hub.example"]) == 0
    assert list(saved.values()) == ["private-test-value"]
    assert "private-test-value" not in (tmp_path / "background.json").read_text()
    monkeypatch.setattr(credentials, "read_token", lambda account: saved[account])
    assert load_config()["token"] == "private-test-value"
    monkeypatch.setattr(
        credentials,
        "read_token",
        lambda _: (_ for _ in ()).throw(AssertionError("unlock attempted")),
    )
    assert main(["background", "disable"]) == 0
    assert main(["background", "status"]) == 0
    assert "private-test-value" not in capsys.readouterr().out


def test_rejected_rows_are_not_a_success_and_do_not_leak(tmp_path, monkeypatch):
    import pytest

    import life_data
    from life_data import background

    background.write_json(tmp_path / "background.json", {"enabled": True})
    monkeypatch.setenv("LIFE_HUB_TOKEN", "test-credential")
    monkeypatch.setattr(life_data, "hub_from_config", lambda _: object())
    monkeypatch.setattr(
        life_data,
        "sync",
        lambda *_: {
            "pushed": 0,
            "pulled": 0,
            "ddl_applied": 0,
            "rejected": [{"id": "private-row", "error": "private-detail"}],
        },
    )
    monkeypatch.setattr(
        background.time, "sleep", lambda _: (_ for _ in ()).throw(KeyboardInterrupt())
    )
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    report = background.status(tmp_path)
    assert report["last_success"] is None
    assert report["last_error"] == "hub rejected rows"
    assert report["stats"]["rejected"] == 1
    assert "private" not in (tmp_path / "background-status.json").read_text()


def test_wrapped_unauthorized_reloads_credential_and_redacts_body(tmp_path, monkeypatch):
    import urllib.error

    import pytest

    import life_data
    from life_data import background

    background.write_json(tmp_path / "background.json", {"enabled": True})
    calls = []
    monkeypatch.setattr(background, "_credential", lambda *_: calls.append("read") or "test-token")
    monkeypatch.setattr(life_data, "hub_from_config", lambda _: object())

    def sync(*_):
        try:
            raise urllib.error.HTTPError("https://hub.example", 401, "unauthorized", {}, None)
        except urllib.error.HTTPError as exc:
            raise RuntimeError("private body") from exc

    monkeypatch.setattr(life_data, "sync", sync)
    ticks = []
    monkeypatch.setattr(background.time, "monotonic", lambda: len(ticks) * 61)

    def sleep(_):
        ticks.append(1)
        if len(ticks) == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr(background.time, "sleep", sleep)
    with pytest.raises(KeyboardInterrupt):
        background.run(tmp_path, 30)
    assert calls == ["read", "read"]
    assert background.status(tmp_path)["last_error"] == "HTTP 401"
    assert "private body" not in (tmp_path / "background-status.json").read_text()


def test_keychain_save_uses_same_env_endpoint_as_lookup(tmp_path, monkeypatch):
    import io

    from life_data import credentials, load_config, main
    from life_data.background import keychain_account

    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", "https://env.example/")
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    monkeypatch.setattr(sys, "stdin", io.StringIO("test-token"))
    saved = {}
    monkeypatch.setattr(
        credentials, "store_token", lambda account, token: saved.update({account: token})
    )
    monkeypatch.setattr(credentials, "read_token", saved.get)
    assert (
        main(["background", "enable", "--hub-url", "https://config.example", "--token-stdin"]) == 0
    )
    assert saved == {keychain_account(tmp_path, "https://env.example"): "test-token"}
    assert load_config()["token"] == "test-token"


def test_changing_hubs_requires_a_fresh_data_directory(tmp_path):
    import pytest

    from life_data import HttpHub, create_table, init, insert_rows, sync

    path = init(tmp_path / "client.db")
    create_table(path, "items", ["name:text"])
    insert_rows(path, "items", [{"id": "one", "name": "First"}])
    first = _serve(tmp_path / "first.db")
    second = None
    try:
        sync(
            path,
            HttpHub(f"http://127.0.0.1:{first.server_port}", {"Authorization": "Bearer testtoken"}),
        )
        second = _serve(tmp_path / "second.db")
        with pytest.raises(ValueError, match="fresh data directory"):
            sync(
                path,
                HttpHub(
                    f"http://127.0.0.1:{second.server_port}", {"Authorization": "Bearer testtoken"}
                ),
            )
        assert (
            execute_sql(tmp_path / "second.db", "SELECT name FROM sqlite_master WHERE name='items'")
            == []
        )
    finally:
        first.shutdown()
        if second:
            second.shutdown()


def test_legacy_cursor_cannot_be_repointed_by_enable(tmp_path, monkeypatch):
    from life_data import _set_state, init, main
    from life_data.background import read_json

    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("LIFE_HUB_URL", raising=False)
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    (tmp_path / "config.json").write_text(json.dumps({"hub_url": "https://first.example"}))
    path = init(tmp_path / "life.db")
    _set_state(path, "last_push", "2026-01-01T00:00:00.000Z")
    assert main(["background", "enable", "--hub-url", "https://second.example"]) == 1
    assert read_json(tmp_path / "background.json") == {}


def test_legacy_http_cursors_are_not_trusted_without_an_endpoint(tmp_path):
    from life_data import HttpHub, _set_state, create_table, init, insert_rows, sync

    path = init(tmp_path / "client.db")
    create_table(path, "items", ["name:text"])
    insert_rows(path, "items", [{"id": "one", "name": "First"}])
    # A replica made by the old client has cursors but no recorded endpoint.
    _set_state(path, "last_push", "2099-01-01T00:00:00.000Z")
    _set_state(path, "last_pull", "2099-01-01T00:00:00.000Z")
    server = _serve(tmp_path / "hub.db")
    try:
        result = sync(
            path,
            HttpHub(
                f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer testtoken"}
            ),
        )
        assert result["rejected"] == []
        assert execute_sql(tmp_path / "hub.db", "SELECT name FROM items") == [{"name": "First"}]
    finally:
        server.shutdown()
