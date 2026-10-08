"""Profile enrollment: interactive device login and the two-step headless flow."""

import json
import stat
import sys
from urllib.parse import parse_qs, urlparse

import pytest

from life_data import login, main
from life_data.background import keychain_account

HUB = "https://hub.example"
PROFILE = "flight-sync-v1"


@pytest.fixture
def hub(monkeypatch):
    """A fake hub: approve(key) makes a fingerprint's session live with `session(key)`."""
    state = {"approved": {}, "requests": [], "revoked": []}

    def session(key, profile=PROFILE, scopes=("tables:read:flights", "files:write:raw/flighty/")):
        return {
            "name": "device:" + key,
            "scopes": list(scopes),
            "enrollmentProfile": {"id": profile, "revision": "b" * 64},
            "capabilities": {"row_api": "v1", "schema": "none", "replica_sync": False},
        }

    def request(endpoint, route, method, token, **kwargs):
        key = login.token_fingerprint(token)
        state["requests"].append((method, route))
        if key not in state["approved"]:
            return 401, None
        if method == "POST":
            state["revoked"].append(key)
            del state["approved"][key]
            return 200, {"logged_out": True}
        return 200, state["approved"][key]

    state["session"] = session
    monkeypatch.setattr(login, "_request_json", request)
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    monkeypatch.delenv("LIFE_HUB_URL", raising=False)
    return state


def approve_url(hub, url, **overrides):
    query = parse_qs(urlparse(url).query)
    key = query["key"][0]
    hub["approved"][key] = hub["session"](key, **overrides)
    return query


@pytest.fixture
def keychain(monkeypatch):
    import ctypes

    from life_data import credentials

    monkeypatch.setattr(ctypes, "CDLL", lambda *_: pytest.fail("native access forbidden"))
    monkeypatch.setattr(sys, "platform", "darwin")
    tokens = {}
    monkeypatch.setattr(credentials, "read_token", tokens.get)
    monkeypatch.setattr(
        credentials, "store_token", lambda account, token: tokens.update({account: token})
    )
    monkeypatch.setattr(credentials, "delete_token", lambda account: tokens.pop(account, None))
    return tokens


def test_device_profile_login_requests_the_profile_and_saves_the_bound_token(
    tmp_path, hub, keychain
):
    seen = {}

    def browser(url):
        seen.update(approve_url(hub, url))
        return True

    result = login.login(tmp_path, hub_url=HUB, name="Phone", profile=PROFILE, open_browser=browser)
    assert seen["profile"] == [PROFILE] and seen["name"] == ["Phone"]
    assert result["scopes"] == ["tables:read:flights", "files:write:raw/flighty/"]
    token = keychain[keychain_account(tmp_path, HUB)]
    assert login.token_fingerprint(token) == seen["key"][0]


def test_device_profile_login_revokes_a_session_bound_to_another_profile(tmp_path, hub, keychain):
    def browser(url):
        approve_url(hub, url, profile="other-profile")
        return True

    with pytest.raises(login.LoginError, match="profile does not match"):
        login.login(tmp_path, hub_url=HUB, name="Phone", profile=PROFILE, open_browser=browser)
    assert hub["revoked"] and not keychain


def test_device_profile_login_refuses_to_replace_an_active_full_session(tmp_path, hub, keychain):
    keychain[keychain_account(tmp_path, HUB)] = "lt_existing"
    hub["approved"][login.token_fingerprint("lt_existing")] = {
        "name": "device:x",
        "scopes": ["full"],
    }
    with pytest.raises(login.LoginError, match="log out"):
        login.login(tmp_path, hub_url=HUB, name="Phone", profile=PROFILE, open_browser=None)


def test_start_writes_a_private_state_file_and_prints_only_the_approval_url(
    tmp_path, hub, monkeypatch, capsys
):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path / "data"))
    state_file = tmp_path / "pending.json"
    args = ["login", "--hub-url", HUB, "--profile", PROFILE, "--name", "Flighty server"]
    assert main([*args, "--start", str(state_file)]) == 0
    out = json.loads(capsys.readouterr().out)
    state = json.loads(state_file.read_text())
    assert stat.S_IMODE(state_file.stat().st_mode) == 0o600
    query = parse_qs(urlparse(out["approval_url"]).query)
    assert query == {
        "key": [login.token_fingerprint(state["token"])],
        "name": ["Flighty server"],
        "profile": [PROFILE],
    }
    assert out["approval_code"] == query["key"][0][:8]
    assert state["token"] not in json.dumps(out)
    assert hub["requests"] == []
    assert main([*args, "--start", str(state_file)]) == 1
    assert "exists" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        ["--start", "s.json"],
        ["--profile", PROFILE, "--start", "s.json", "--token-stdin"],
        ["--claim", "s.json", "--profile", PROFILE],
        ["--wait"],
        ["--profile", "Not_A_Profile", "--start", "s.json"],
    ],
)
def test_headless_flags_reject_ambiguous_combinations(tmp_path, monkeypatch, capsys, argv):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    assert main(["login", "--hub-url", HUB, *argv]) == 1
    assert "error:" in capsys.readouterr().err
    assert not (tmp_path / "s.json").exists()


def start(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path / "data"))
    state_file = tmp_path / "pending.json"
    result = login.start_enrollment(
        tmp_path / "data", state_file, hub_url=HUB, profile=PROFILE, name="Flighty server"
    )
    return state_file, result["approval_url"]


def test_claim_before_approval_fails_and_keeps_the_state_file(tmp_path, hub, monkeypatch, capsys):
    state_file, _ = start(tmp_path, monkeypatch)
    assert main(["login", "--claim", str(state_file)]) == 1
    assert "not approved yet" in capsys.readouterr().err
    assert state_file.exists() and hub["requests"] == [("GET", "/v1/session")]


def test_claim_prints_only_the_approved_token_then_deletes_the_state_file(
    tmp_path, hub, monkeypatch, capsys
):
    state_file, url = start(tmp_path, monkeypatch)
    token = json.loads(state_file.read_text())["token"]
    approve_url(hub, url)
    assert main(["login", "--claim", str(state_file)]) == 0
    captured = capsys.readouterr()
    assert captured.out == token + "\n"
    assert token not in captured.err
    assert not state_file.exists()


def test_claim_wait_polls_until_approval(tmp_path, hub, monkeypatch, capsys):
    state_file, url = start(tmp_path, monkeypatch)
    sleeps = []

    def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            approve_url(hub, url)

    monkeypatch.setattr(login.time, "sleep", sleep)
    assert main(["login", "--claim", str(state_file), "--wait"]) == 0
    assert sleeps == [login.POLL_INTERVAL, login.POLL_INTERVAL]
    assert capsys.readouterr().out.startswith("lt_")


@pytest.mark.parametrize(
    "overrides",
    [{"scopes": ["full"]}, {"profile": "other-profile"}, {"scopes": ["tables:read:history"]}],
)
def test_claim_revokes_an_approval_that_is_not_the_requested_profile(
    tmp_path, hub, monkeypatch, capsys, overrides
):
    state_file, url = start(tmp_path, monkeypatch)
    approve_url(hub, url, **overrides)
    assert main(["login", "--claim", str(state_file)]) == 1
    captured = capsys.readouterr()
    assert captured.out == "" and "profile does not match" in captured.err
    assert hub["revoked"] and not state_file.exists()
