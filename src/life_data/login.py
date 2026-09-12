"""Browser enrollment and local lifecycle for app-issued Life device tokens."""

import hashlib
import json
import os
import platform
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections.abc import Callable
from pathlib import Path

from . import DEFAULT_HUB_URL, _NoRedirect, _open_hub_request, auth_headers, validate_hub_url
from .background import (
    CredentialError,
    credential_lock,
    keychain_account,
    read_json,
    save_credential,
    update_preferences,
)

POLL_INTERVAL = 5
POLL_TIMEOUT = 5 * 60
MAX_RESPONSE_BYTES = 64 * 1024


class LoginError(RuntimeError):
    """A sanitized enrollment or logout failure."""


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _endpoint(data: Path, explicit: str | None = None) -> str:
    if explicit:
        return validate_hub_url(explicit)
    from . import load_config

    return validate_hub_url(load_config(data, resolve_auth=False)["hub_url"])


def _request_json(
    endpoint: str,
    route: str,
    method: str,
    token: str,
    *,
    opener=None,
) -> tuple[int, dict | None]:
    endpoint = validate_hub_url(endpoint)
    headers = {"User-Agent": "life-data/0.2.0", **auth_headers({"token": token})}
    opener = opener or urllib.request.build_opener(_NoRedirect())
    try:
        with _open_hub_request(
            f"{endpoint}{route}", headers, opener=opener, method=method, timeout=30
        ) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise LoginError("hub returned an oversized response")
            try:
                return response.status, json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise LoginError("hub returned invalid session data") from None
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            exc.close()
            raise LoginError(f"hub redirected the session request (HTTP {exc.code})") from None
        exc.close()
        return exc.code, None
    except urllib.error.URLError:
        raise LoginError("hub unreachable") from None
    except TimeoutError:
        raise LoginError("hub request timed out") from None


def _wait_for_approval(
    endpoint: str,
    token: str,
    *,
    opener=None,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict:
    deadline = monotonic() + POLL_TIMEOUT
    while True:
        status, payload = _request_json(endpoint, "/v1/session", "GET", token, opener=opener)
        if status == 200:
            return _validate_session(payload)
        if status not in {401, 403, 429} and not 500 <= status <= 599:
            raise LoginError(f"hub returned HTTP {status} while checking approval")
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise LoginError("device approval timed out")
        sleep(min(POLL_INTERVAL, remaining))


def _validate_session(payload) -> dict:
    if not isinstance(payload, dict):
        raise LoginError("hub returned an invalid session")
    scopes = payload.get("scopes")
    if not isinstance(payload.get("name"), str) or not isinstance(scopes, list):
        raise LoginError("hub returned an invalid session")
    if payload["name"] == "admin" or "admin" in scopes:
        raise LoginError("admin tokens cannot be saved as device credentials")
    return payload


def _session(endpoint: str, token: str, *, opener=None, allow_missing=False) -> dict | None:
    status, payload = _request_json(endpoint, "/v1/session", "GET", token, opener=opener)
    if status == 401 and allow_missing:
        return None
    if status != 200:
        raise LoginError(f"hub rejected the device token (HTTP {status})")
    return _validate_session(payload)


def _revoke(endpoint: str, token: str, *, opener=None) -> None:
    status, payload = _request_json(endpoint, "/v1/session", "POST", token, opener=opener)
    if status == 401 or (
        status == 200 and isinstance(payload, dict) and payload.get("logged_out") is True
    ):
        return
    raise LoginError(f"hub did not revoke the device (HTTP {status})")


def _device_label(name: str | None) -> str:
    label = (name or platform.node() or "Life device").strip()
    if not label or len(label) > 100 or any(ord(c) < 32 or ord(c) == 127 for c in label):
        raise LoginError("device label must be 1-100 printable characters")
    return label


def _save_native(data: Path, endpoint: str, token: str, *, previous: str | None = None) -> None:
    if sys.platform != "darwin":
        raise LoginError("browser device login currently stores credentials on macOS only")
    from .credentials import read_token

    account = keychain_account(data, endpoint)

    def select_native(prefs):
        prefs["hub_url"] = endpoint
        prefs["keychain"] = True
        prefs.pop("signed_out", None)
        prefs.pop("token_cmd", None)

    with credential_lock(data):
        if read_token(account) != previous:
            raise LoginError("device credential changed during login; retry")
        save_credential(data, account, token, previous, select_native)


def login(
    data: Path,
    *,
    hub_url: str | None = None,
    name: str | None = None,
    no_browser: bool = False,
    token_stdin: bool = False,
    stdin=None,
    opener=None,
    open_browser: Callable[[str], bool] = webbrowser.open,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict:
    """Enroll a device through Access or validate a compatibility stdin token."""
    endpoint = _endpoint(data, hub_url)
    label = _device_label(name)
    if sys.platform != "darwin":
        raise LoginError("browser device login currently stores credentials on macOS only")
    from .credentials import read_token

    previous = read_token(keychain_account(data, endpoint))
    session = _session(endpoint, previous, opener=opener, allow_missing=True) if previous else None
    token = previous
    created = False
    if token_stdin:
        import getpass

        source = stdin or sys.stdin
        token = getpass.getpass("Life device token: ") if source.isatty() else source.read().strip()
        if session and token != previous:
            raise LoginError("already signed in; log out before replacing the device credential")
        session = _session(endpoint, token, opener=opener)
    elif session is None:
        token = "lt_" + secrets.token_hex(24)
        fingerprint = token_fingerprint(token)
        query = urllib.parse.urlencode({"key": fingerprint, "name": label})
        approval_url = f"{endpoint}/login?{query}"
        print(f"Open this URL to approve {label}: {approval_url}")
        print(f"Approval code: {fingerprint[:8]}")
        if not no_browser:
            try:
                open_browser(approval_url)
            except Exception as exc:
                raise LoginError("could not open the approval browser") from exc
        session = _wait_for_approval(
            endpoint, token, opener=opener, sleep=sleep, monotonic=monotonic
        )
        created = True
    try:
        _save_native(data, endpoint, token, previous=previous)
    except Exception as exc:  # noqa: BLE001 - any failed install must clean up its new token
        message = (
            str(exc)
            if isinstance(exc, (LoginError, CredentialError))
            else "could not install the device credential"
        )
        if created:
            try:
                _revoke(endpoint, token, opener=opener)
            except Exception:  # noqa: BLE001 - retain recovery instructions for any cleanup failure
                raise LoginError(
                    f"{message}; remote cleanup failed. "
                    f"Revoke device:{token_fingerprint(token)} at {endpoint}/login/devices"
                ) from None
        raise LoginError(message) from None
    return {"hub_url": endpoint, "name": session["name"], "scopes": session["scopes"]}


def _saved_endpoint(data: Path) -> str:
    prefs = read_json(data / "background.json")
    if isinstance(prefs.get("hub_url"), str) and prefs["hub_url"].strip():
        return validate_hub_url(prefs["hub_url"])
    config = read_json(data / "config.json")
    if isinstance(config.get("hub_url"), str) and config["hub_url"].strip():
        return validate_hub_url(config["hub_url"])
    if "LIFE_HUB_URL" in os.environ:
        raise LoginError("cannot log out without the saved hub endpoint")
    return DEFAULT_HUB_URL


def _mark_signed_out(data: Path, endpoint: str) -> None:
    def sign_out(prefs):
        prefs["hub_url"] = endpoint
        prefs["signed_out"] = True
        prefs.pop("keychain", None)

    update_preferences(data, sign_out)


def logout(data: Path, *, opener=None) -> dict:
    """Revoke the saved device remotely, then remove it from local Keychain."""
    from .credentials import delete_token, read_token

    with credential_lock(data):
        endpoint = _saved_endpoint(data)
        account = keychain_account(data, endpoint)
        token = read_token(account)
        if token:
            _revoke(endpoint, token, opener=opener)
        if read_token(account) != token:
            raise LoginError("device credential changed during logout; retry")
        _mark_signed_out(data, endpoint)
        delete_token(account)
    return {"hub_url": endpoint, "logged_out": True}
