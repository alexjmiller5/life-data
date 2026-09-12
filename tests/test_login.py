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
        lambda data, endpoint, token, **kwargs: saved.update(
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


@pytest.fixture(autouse=True)
def native_tokens(monkeypatch):
    """Keep every login test away from the user's credentials and configuration."""
    import ctypes

    from life_data import credentials

    monkeypatch.setattr(ctypes, "CDLL", lambda *_: pytest.fail("native access forbidden"))
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.delenv("LIFE_HUB_TOKEN", raising=False)
    monkeypatch.delenv("LIFE_HUB_URL", raising=False)
    monkeypatch.setattr(login.platform, "node", lambda: "Review device")
    tokens = {}
    monkeypatch.setattr(credentials, "read_token", tokens.get)
    monkeypatch.setattr(
        credentials, "store_token", lambda account, token: tokens.update({account: token})
    )
    monkeypatch.setattr(credentials, "delete_token", lambda account: tokens.pop(account, None))
    return tokens


def test_login_selects_native_auth_and_logout_suppresses_implicit_fallback(tmp_path, monkeypatch):
    from life_data import load_config

    write_json(tmp_path / "config.json", {"token": "old-token", "token_cmd": "exit 99"})
    write_json(tmp_path / "background.json", {"signed_out": True})
    monkeypatch.setattr(
        login, "_wait_for_approval", lambda *a, **k: {"name": "device:x", "scopes": ["full"]}
    )
    login.login(tmp_path, hub_url="https://hub.example", no_browser=True)
    assert "signed_out" not in read_json(tmp_path / "background.json")
    assert load_config(tmp_path)["token"].startswith("lt_")
    monkeypatch.setattr(login, "_request_json", lambda *a, **k: (200, {"logged_out": True}))
    login.logout(tmp_path)
    assert load_config(tmp_path)["token"] is None
    monkeypatch.setenv("LIFE_HUB_TOKEN", "explicit-operator-token")
    assert load_config(tmp_path)["token"] == "explicit-operator-token"


def test_selected_native_auth_does_not_fall_back_when_item_missing(tmp_path):
    from life_data import load_config

    write_json(tmp_path / "config.json", {"token_cmd": "exit 99"})
    write_json(tmp_path / "background.json", {"keychain": True})
    assert not load_config(tmp_path)["token"]


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://hub.example",
        "http://127.0.0.1.evil.test",
        "http://192.168.1.1",
        "https://user:password@hub.example",
        "https://hub.example?token=x",
        "https://hub.example#ignored",
        "file:///tmp/hub",
        "https://hub.example:bad",
        "https://hub.example\n",
        "http://2130706433",
        "https://",
        "//hub.example",
    ],
)
def test_unsafe_endpoint_rejected_before_browser_or_network(tmp_path, monkeypatch, endpoint):
    from life_data import HttpHub

    monkeypatch.setattr(
        login, "_wait_for_approval", lambda *a, **k: pytest.fail("network attempted")
    )
    with pytest.raises(ValueError, match="hub URL"):
        HttpHub(endpoint, {"Authorization": "Bearer fixture"})
    with pytest.raises(ValueError, match="hub URL"):
        login.login(
            tmp_path, hub_url=endpoint, open_browser=lambda _: pytest.fail("browser opened")
        )


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://hub.example",
        "https://hub.example/base/",
        "http://localhost:8765",
        "http://127.0.0.1:8765",
        "http://[::1]:8765",
    ],
)
def test_secure_or_loopback_endpoint_allowed(endpoint):
    from life_data import HttpHub

    assert HttpHub(endpoint).base == endpoint.rstrip("/")


def test_credential_bearing_get_post_and_session_requests_never_follow_redirects():
    import threading
    from contextlib import ExitStack
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from life_data import HttpHub

    captured = []

    class Target(BaseHTTPRequestHandler):
        def do_GET(self):
            captured.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_):
            pass

    with ExitStack() as cleanup:
        target = ThreadingHTTPServer(("127.0.0.1", 0), Target)

        class Redirect(Target):
            def do_GET(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                code = int(self.path.rsplit("/", 1)[-1])
                self.send_response(code)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/capture")
                self.end_headers()

            do_POST = do_GET

        origin = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        for server in (target, origin):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cleanup.callback(thread.join)
            cleanup.callback(server.server_close)
            cleanup.callback(server.shutdown)
        endpoint = f"http://127.0.0.1:{origin.server_port}"
        hub = HttpHub(endpoint, {"Authorization": "Bearer fixture-token"})
        for code in (301, 302, 303, 307, 308):
            with pytest.raises(RuntimeError, match=f"HTTP {code}"):
                hub._get(f"/redirect/{code}")
            with pytest.raises(RuntimeError, match=f"HTTP {code}"):
                hub._post(f"/redirect/{code}", {})
            with pytest.raises(login.LoginError, match=f"HTTP {code}"):
                login._request_json(endpoint, f"/redirect/{code}", "GET", "fixture-token")
        assert captured == []


def test_signed_out_or_missing_native_token_cannot_reuse_config_authorization_header(tmp_path):
    from life_data import auth_headers, load_config

    write_json(tmp_path / "config.json", {"headers": {"authorization": "Bearer fixture-old"}})
    for state in ({"signed_out": True}, {"keychain": True}):
        write_json(tmp_path / "background.json", state)
        assert not any(
            key.lower() == "authorization" for key in auth_headers(load_config(tmp_path))
        )


@pytest.mark.parametrize(
    "response",
    [
        (403, None),
        (500, None),
        (200, None),
        (200, {}),
        (200, {"logged_out": False}),
        (200, {"logged_out": 1}),
        (200, {"error": "denied"}),
        (200, []),
    ],
)
def test_logout_retains_credential_and_preferences_without_proven_revocation(
    tmp_path, monkeypatch, native_tokens, response
):
    endpoint = "https://hub.example"
    account = keychain_account(tmp_path, endpoint)
    native_tokens[account] = "fixture-token"
    prefs = {"hub_url": endpoint, "keychain": True, "enabled": True, "revision": 4}
    write_json(tmp_path / "background.json", prefs)
    monkeypatch.setattr(login, "_request_json", lambda *a, **k: response)
    with pytest.raises(login.LoginError, match="revoke"):
        login.logout(tmp_path)
    assert native_tokens[account] == "fixture-token"
    assert read_json(tmp_path / "background.json") == prefs


@pytest.fixture
def enrollment(tmp_path, monkeypatch, native_tokens):
    from types import SimpleNamespace
    from urllib.parse import parse_qs, urlparse

    registry, browsers, requests = {}, [], []

    def browser(url):
        key = parse_qs(urlparse(url).query)["key"][0]
        browsers.append(key)
        registry[key] = True
        return True

    def request(endpoint, route, method, token, **kwargs):
        key = login.token_fingerprint(token)
        requests.append((method, key))
        if not registry.get(key):
            return 401, None
        if method == "POST":
            registry[key] = False
            return 200, {"logged_out": True}
        return 200, {"name": "device:" + key, "scopes": ["full"]}

    monkeypatch.setattr(login, "_request_json", request)
    endpoint = "https://hub.example"
    account = keychain_account(tmp_path, endpoint)

    def run(**kwargs):
        return login.login(
            tmp_path, hub_url=endpoint, name="Review device", open_browser=browser, **kwargs
        )

    return SimpleNamespace(
        run=run,
        registry=registry,
        browsers=browsers,
        requests=requests,
        tokens=native_tokens,
        account=account,
        request=request,
    )


def test_repeat_valid_login_reuses_the_same_credential_and_logout_revokes_it(tmp_path, enrollment):
    first = enrollment.run()
    token = enrollment.tokens[enrollment.account]
    second = enrollment.run()
    assert first == second
    assert enrollment.tokens[enrollment.account] == token
    assert len(enrollment.browsers) == len(enrollment.registry) == 1
    login.logout(tmp_path)
    assert not enrollment.tokens and not any(enrollment.registry.values())


def test_login_does_not_replace_an_existing_credential_on_transient_rejection(
    tmp_path, monkeypatch, enrollment
):
    enrollment.run()
    original = dict(enrollment.tokens)
    monkeypatch.setattr(login, "_request_json", lambda *a, **k: (403, None))
    monkeypatch.setattr(
        login, "_wait_for_approval", lambda *a, **k: pytest.fail("must retain existing session")
    )
    with pytest.raises(login.LoginError, match="403"):
        enrollment.run()
    assert enrollment.tokens == original and len(enrollment.browsers) == 1


def test_login_replaces_a_credential_only_after_the_hub_says_it_is_invalid(enrollment):
    enrollment.run()
    old = enrollment.tokens[enrollment.account]
    enrollment.registry[login.token_fingerprint(old)] = False
    enrollment.run()
    assert enrollment.tokens[enrollment.account] != old
    assert sum(enrollment.registry.values()) == 1


def test_stdin_cannot_silently_replace_an_active_credential(enrollment):
    enrollment.run()
    original = dict(enrollment.tokens)
    with pytest.raises(login.LoginError, match="log out"):
        enrollment.run(token_stdin=True, stdin=io.StringIO("another-fixture-token"))
    assert enrollment.tokens == original and sum(enrollment.registry.values()) == 1


def test_failed_native_install_cleans_up_the_newly_approved_token(monkeypatch, enrollment):
    from life_data import credentials

    def unavailable(*args):
        raise credentials.KeychainError("fixture storage failure")

    monkeypatch.setattr(credentials, "store_token", unavailable)
    with pytest.raises(login.LoginError, match="install"):
        enrollment.run()
    assert len(enrollment.registry) == 1 and not any(enrollment.registry.values())
    assert not enrollment.tokens


def test_install_failure_on_reused_login_never_revokes_existing_token(monkeypatch, enrollment):
    enrollment.run()
    original = dict(enrollment.tokens)

    def unavailable(*args, **kwargs):
        raise OSError("fixture preference failure")

    monkeypatch.setattr(login, "_save_native", unavailable)
    with pytest.raises(login.LoginError, match="install"):
        enrollment.run()
    assert enrollment.tokens == original and all(enrollment.registry.values())
    assert len(enrollment.registry) == 1


def test_failed_install_reports_failed_remote_cleanup_without_disclosing_token(
    monkeypatch, enrollment
):
    import traceback

    from life_data import credentials

    def unavailable(*args):
        raise credentials.KeychainError("fixture private diagnostic")

    def request(endpoint, route, method, token, **kwargs):
        if method == "POST":
            return 503, None
        return enrollment.request(endpoint, route, method, token, **kwargs)

    monkeypatch.setattr(credentials, "store_token", unavailable)
    monkeypatch.setattr(login, "_request_json", request)
    with pytest.raises(login.LoginError, match="cleanup failed") as error:
        enrollment.run()
    assert all(enrollment.registry.values())
    output = "".join(traceback.format_exception(error.value))
    assert "fixture private diagnostic" not in output and "lt_" not in output
    assert "device:" + enrollment.browsers[0] in output


@pytest.mark.parametrize("existing", [False, True])
def test_preference_write_failure_restores_the_previous_native_item(
    tmp_path, monkeypatch, enrollment, existing
):
    import os

    if existing:
        enrollment.run()
        enrollment.registry[login.token_fingerprint(enrollment.tokens[enrollment.account])] = False
    original = dict(enrollment.tokens)
    before = read_json(tmp_path / "background.json")

    def fail_replace(*args):
        raise OSError("fixture preference write failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(login.LoginError, match="install"):
        enrollment.run()
    assert enrollment.tokens == original
    assert read_json(tmp_path / "background.json") == before
    assert not any(enrollment.registry.values())


def test_logout_local_preference_failure_keeps_the_revoked_token_for_retry(
    tmp_path, monkeypatch, enrollment
):
    import os

    enrollment.run()
    original = dict(enrollment.tokens)

    def fail_replace(*args):
        raise OSError("fixture preference write failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises((OSError, login.LoginError)):
        login.logout(tmp_path)
    assert enrollment.tokens == original
    assert not any(enrollment.registry.values())


def test_logout_does_not_delete_a_credential_installed_while_revocation_was_pending(
    tmp_path, monkeypatch, enrollment
):
    enrollment.run()

    def request(*args, **kwargs):
        result = enrollment.request(*args, **kwargs)
        enrollment.tokens[enrollment.account] = "concurrent-fixture-token"
        return result

    monkeypatch.setattr(login, "_request_json", request)
    with pytest.raises(login.LoginError, match="changed"):
        login.logout(tmp_path)
    assert enrollment.tokens[enrollment.account] == "concurrent-fixture-token"
    assert read_json(tmp_path / "background.json")["keychain"] is True


def test_concurrent_install_cannot_overwrite_a_credential_read_before_its_creation(
    tmp_path, monkeypatch, native_tokens
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from life_data import credentials
    from life_data.background import CredentialLockError

    entered, release = Event(), Event()
    endpoint = "https://hub.example"

    def store(account, token):
        if token == "first-fixture":
            entered.set()
            assert release.wait(3)
        native_tokens[account] = token

    monkeypatch.setattr(credentials, "store_token", store)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(login._save_native, tmp_path, endpoint, "first-fixture")
        try:
            assert entered.wait(3)
            second = pool.submit(login._save_native, tmp_path, endpoint, "second-fixture")
            with pytest.raises(CredentialLockError):
                second.result(timeout=2)
        finally:
            release.set()
        first.result(timeout=2)
    assert native_tokens[keychain_account(tmp_path, endpoint)] == "first-fixture"


def test_contended_logout_cannot_revoke_a_reused_login_before_it_commits(
    tmp_path, monkeypatch, enrollment
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from life_data import background

    enrollment.run()
    entered, release = Event(), Event()
    original = background.write_json

    def paused(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)

    monkeypatch.setattr(background, "write_json", paused)
    with ThreadPoolExecutor(max_workers=1) as pool:
        reused_login = pool.submit(enrollment.run)
        try:
            assert entered.wait(5)
            with pytest.raises(RuntimeError, match="credential update"):
                login.logout(tmp_path)
            assert all(enrollment.registry.values())
            assert all(method != "POST" for method, _ in enrollment.requests)
        finally:
            release.set()
        assert reused_login.result(timeout=5)["scopes"] == ["full"]
    assert enrollment.tokens and all(enrollment.registry.values())


def test_logout_holds_lifecycle_lock_before_native_read_and_remote_revoke(
    tmp_path, monkeypatch, enrollment
):
    import fcntl

    from life_data import credentials

    enrollment.run()
    original_read = credentials.read_token

    def assert_locked():
        with (
            (tmp_path / "credentials.lock").open("a+") as lock,
            pytest.raises(BlockingIOError),
        ):
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def read(account):
        assert_locked()
        return original_read(account)

    def request(*args, **kwargs):
        assert_locked()
        with (tmp_path / "preferences.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return enrollment.request(*args, **kwargs)

    monkeypatch.setattr(credentials, "read_token", read)
    monkeypatch.setattr(login, "_request_json", request)
    assert login.logout(tmp_path)["logged_out"] is True
    assert not enrollment.tokens and not any(enrollment.registry.values())


@pytest.mark.parametrize("suffix", ["\nextra", "\rextra", "\x00", "\x7f", "\u2603"])
def test_malformed_stdin_credential_is_not_printed_or_sent(tmp_path, monkeypatch, capsys, suffix):
    import socket

    from life_data import main

    token = "fixture-private-token" + suffix
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(sys, "stdin", io.StringIO(token))
    monkeypatch.setattr(
        socket, "create_connection", lambda *_a, **_k: pytest.fail("network attempted")
    )
    assert main(["login", "--hub-url", "http://127.0.0.1:1", "--token-stdin"]) == 1
    output = capsys.readouterr()
    assert "fixture-private-token" not in output.out + output.err
    assert "header" in output.err.lower()


@pytest.mark.parametrize("caller", ["auth_headers", "session", "get", "post"])
@pytest.mark.parametrize("suffix", ["\nextra", "\x00", "\u2603"])
def test_shared_callers_reject_malformed_headers_without_exception_disclosure(
    monkeypatch, caller, suffix
):
    import traceback
    import urllib.request

    from life_data import HttpHub, auth_headers

    token = "fixture-private-token" + suffix
    monkeypatch.setattr(
        urllib.request.OpenerDirector, "open", lambda *_a, **_k: pytest.fail("transport attempted")
    )
    with pytest.raises(ValueError, match="header") as error:
        if caller == "auth_headers":
            auth_headers({"token": token})
        elif caller == "session":
            login._request_json("https://hub.example", "/v1/session", "GET", token)
        else:
            hub = HttpHub("https://hub.example", {"X-Proxy-Credential": token})
            if caller == "get":
                hub._get("/test")
            else:
                hub._post("/test", {})
    assert "fixture-private-token" not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize("caller", ["session", "get", "post"])
def test_header_serialization_exception_is_sanitized(monkeypatch, caller):
    import traceback
    import urllib.request

    from life_data import HttpHub

    def fail(*_args, **_kwargs):
        raise ValueError("fixture-private-serialization-diagnostic")

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(ValueError, match="header") as error:
        if caller == "session":
            login._request_json("https://hub.example", "/v1/session", "GET", "fixture")
        else:
            hub = HttpHub("https://hub.example", {"Authorization": "Bearer fixture"})
            if caller == "get":
                hub._get("/test")
            else:
                hub._post("/test", {})
    assert "fixture-private" not in "".join(traceback.format_exception(error.value))
