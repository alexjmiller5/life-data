import io
import sys

import pytest

from life_data import login
from life_data.background import keychain_account, read_json, write_json


def test_browser_login_stores_an_app_token_without_enabling_background(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(sys, "platform", "darwin")
    saved = {}
    monkeypatch.setattr(
        login,
        "_wait_for_approval",
        lambda *args, **kwargs: {"name": "device:x", "scopes": ["full"]},
    )
    monkeypatch.setattr(
        login,
        "_save_native",
        lambda data, endpoint, token: saved.update(
            {"data": data, "endpoint": endpoint, "token": token}
        ),
    )
    result = login.login(
        tmp_path, hub_url="https://hub.example", name="MacBook Air", no_browser=True
    )
    assert result == {"hub_url": "https://hub.example", "name": "device:x", "scopes": ["full"]}
    output = capsys.readouterr().out
    assert "https://hub.example/login?" in output
    assert "lt_" not in output
    assert saved["endpoint"] == "https://hub.example"
    assert saved["token"].startswith("lt_")


def test_native_save_rereads_preferences_and_preserves_concurrent_disable(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    write_json(tmp_path / "background.json", {"enabled": True, "revision": 8, "token_cmd": "old"})
    saved = {}

    def store(account, token):
        saved[account] = token
        write_json(
            tmp_path / "background.json", {"enabled": False, "revision": 9, "token_cmd": "new"}
        )

    monkeypatch.setattr("life_data.credentials.store_token", store)
    login._save_native(tmp_path, "https://hub.example", "lt_test")
    prefs = read_json(tmp_path / "background.json")
    assert prefs == {
        "enabled": False,
        "revision": 10,
        "hub_url": "https://hub.example",
        "keychain": True,
    }
    assert saved[keychain_account(tmp_path, "https://hub.example")] == "lt_test"


def test_stdin_compatibility_rejects_an_admin_token_before_keychain_write(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(
        login,
        "_request_json",
        lambda *args, **kwargs: (200, {"name": "admin", "scopes": ["admin"]}),
    )
    monkeypatch.setattr(
        login, "_save_native", lambda *args: pytest.fail("admin token must not be saved")
    )
    with pytest.raises(login.LoginError, match="admin"):
        login.login(
            tmp_path, hub_url="https://hub.example", token_stdin=True, stdin=io.StringIO("lt_admin")
        )


def test_logout_requires_a_saved_endpoint_instead_of_using_operator_override(tmp_path, monkeypatch):
    monkeypatch.setenv("LIFE_HUB_URL", "https://wrong.example")
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr("life_data.credentials.read_token", lambda account: "lt_secret")
    with pytest.raises(login.LoginError, match="saved hub endpoint"):
        login.logout(tmp_path)


def test_logout_releases_keychain_only_after_authoritative_remote_result(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    write_json(
        tmp_path / "background.json",
        {"hub_url": "https://hub.example", "enabled": True, "revision": 2},
    )
    deleted = []
    monkeypatch.setattr("life_data.credentials.read_token", lambda account: "lt_secret")
    monkeypatch.setattr(
        "life_data.credentials.delete_token", lambda account: deleted.append(account)
    )
    calls = []

    def request(*args, **kwargs):
        calls.append(args[1:3])
        return 401, None

    monkeypatch.setattr(login, "_request_json", request)
    assert login.logout(tmp_path) == {"hub_url": "https://hub.example", "logged_out": True}
    assert calls == [("/v1/session", "POST")]
    assert deleted == [keychain_account(tmp_path, "https://hub.example")]
    prefs = read_json(tmp_path / "background.json")
    assert prefs == {
        "hub_url": "https://hub.example",
        "enabled": True,
        "revision": 3,
        "signed_out": True,
    }


def test_approval_wait_retries_pending_status_then_returns_session(monkeypatch):
    responses = iter([(401, None), (403, None), (200, {"name": "device:x", "scopes": ["full"]})])
    clock = iter([0, 0, 1, 1, 2])
    sleeps = []
    monkeypatch.setattr(login, "_request_json", lambda *args, **kwargs: next(responses))
    result = login._wait_for_approval(
        "https://hub.example", "lt_secret", sleep=sleeps.append, monotonic=lambda: next(clock)
    )
    assert result["name"] == "device:x"
    assert sleeps == [5, 5]
