"""Browser enrollment and local lifecycle for app-issued Soma device tokens."""

import hashlib
import json
import os
import platform
import re
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

# Same grammar as core/src/enrollment-scopes.ts; tests/fixtures/enrollment-scopes.json
# is the shared contract. Full, admin and token administration never qualify.
_SIMPLE_SCOPE = re.compile(
    r"tables:read|tables:write|streams:append|backups:read|backups:write"
    r"|captures:(?:submit|read):[a-z][a-z0-9-]{0,63}"
    r"|streams:(?:read|append):[A-Za-z0-9_-]{1,64}"
    r"|subscriptions:consume:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|rows:create:[a-z][a-z0-9_-]{0,63}:[0-9a-f]{64}"
    r"|files:(?:read|write):(?:[A-Za-z0-9_][A-Za-z0-9._-]*/)+"
)
_WHOLE_TABLE = re.compile(r"tables:(?:read|write):([A-Za-z][A-Za-z0-9_]*)")
_EDGE = re.compile(r"provenance:create:([A-Za-z][A-Za-z0-9_]*)")
_COLUMN = re.compile(
    r"(tables:read|tables:patch|catalog:read):([A-Za-z][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)"
)
_RESERVED = re.compile(r"(?:sqlite_|catalog_).*|history|provenance|purges", re.IGNORECASE)
_SYSTEM_COLUMNS = {"id", "created_at", "updated_at", "hub_at", "deleted_at"}


def valid_profile_scopes(scopes) -> bool:
    if (
        not isinstance(scopes, list)
        or not 0 < len(scopes) <= 256
        or not all(isinstance(s, str) for s in scopes)
        or len(set(scopes)) != len(scopes)
    ):
        return False

    def valid(scope: str) -> bool:
        if _SIMPLE_SCOPE.fullmatch(scope):
            return True
        if whole := _WHOLE_TABLE.fullmatch(scope):
            return not _RESERVED.fullmatch(whole[1])
        if edge := _EDGE.fullmatch(scope):  # origin edges onto rows the profile may write
            return not _RESERVED.fullmatch(edge[1]) and f"tables:write:{edge[1]}" in scopes
        p = _COLUMN.fullmatch(scope)
        if not p or _RESERVED.fullmatch(p[2]) or f"tables:read:{p[2]}:id" not in scopes:
            return False
        if p[1] == "catalog:read":
            return f"tables:read:{p[2]}:{p[3]}" in scopes
        return p[1] == "tables:read" or (
            p[3] not in _SYSTEM_COLUMNS
            and all(f"tables:read:{p[2]}:{c}" in scopes for c in (p[3], "updated_at", "hub_at"))
        )

    return all(valid(s) for s in scopes)


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
    headers = {"User-Agent": "soma/0.2.0", **auth_headers({"token": token})}
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


def _validate_profile_session(payload: dict, fingerprint: str, profile: str) -> dict:
    """An approval must be exactly the requested profile on exactly this candidate."""
    receipt, caps = payload.get("enrollmentProfile"), payload.get("capabilities")
    if (
        payload.get("name") != f"device:{fingerprint}"
        or not isinstance(receipt, dict)
        or receipt.get("id") != profile
        or not valid_profile_scopes(payload.get("scopes"))
        or not isinstance(caps, dict)
        or caps.get("replica_sync") is not False
    ):
        raise LoginError("device approval profile does not match")
    return payload


def _check_profile_id(profile: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", profile):
        raise LoginError("profile must match [a-z][a-z0-9-]{0,63}")


def _approval_url(endpoint: str, fingerprint: str, label: str, profile: str | None) -> str:
    query = {"key": fingerprint, "name": label, **({"profile": profile} if profile else {})}
    return f"{endpoint}/login?{urllib.parse.urlencode(query)}"


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
    label = (name or platform.node() or "Soma device").strip()
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
    profile: str | None = None,
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
    if profile is not None:
        _check_profile_id(profile)
        if token_stdin:
            raise LoginError("a profile enrollment cannot use a pasted token")
    if sys.platform != "darwin":
        raise LoginError("browser device login currently stores credentials on macOS only")
    from .credentials import read_token

    previous = read_token(keychain_account(data, endpoint))
    session = _session(endpoint, previous, opener=opener, allow_missing=True) if previous else None
    if profile and session and (session.get("enrollmentProfile") or {}).get("id") != profile:
        raise LoginError("already signed in; log out before enrolling with a profile")
    token = previous
    created = False
    if token_stdin:
        import getpass

        source = stdin or sys.stdin
        token = getpass.getpass("Soma device token: ") if source.isatty() else source.read().strip()
        if session and token != previous:
            raise LoginError("already signed in; log out before replacing the device credential")
        session = _session(endpoint, token, opener=opener)
    elif session is None:
        token = "lt_" + secrets.token_hex(24)
        fingerprint = token_fingerprint(token)
        approval_url = _approval_url(endpoint, fingerprint, label, profile)
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
        if profile:
            _validate_profile_session(session, token_fingerprint(token), profile)
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


def start_enrollment(
    data: Path, state_file: Path, *, hub_url: str | None, profile: str, name: str | None
) -> dict:
    """Headless step one: a private pending enrollment plus the URL the owner approves.

    Nothing touches the network or Keychain; the candidate token lives only in the
    0600 state file until `claim_enrollment` hands it to the operator."""
    _check_profile_id(profile)
    endpoint = _endpoint(data, hub_url)
    label = _device_label(name)
    token = "lt_" + secrets.token_hex(24)
    fingerprint = token_fingerprint(token)
    state = {"hub_url": endpoint, "profile": profile, "token": token}
    try:
        fd = os.open(state_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise LoginError(f"state file {state_file} already exists") from None
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    return {
        "approval_url": _approval_url(endpoint, fingerprint, label, profile),
        "approval_code": fingerprint[:8],
        "state_file": str(state_file),
    }


def claim_enrollment(
    state_file: Path,
    *,
    wait: bool = False,
    opener=None,
    sleep: Callable[[float], None] | None = None,
    monotonic: Callable[[], float] | None = None,
) -> str:
    """Headless step two: the approved token, or an error that keeps the state file.

    The caller deletes the state file after delivering the token. An approval that
    is not exactly the requested profile is revoked and its state discarded."""
    try:
        state = json.loads(state_file.read_text())
        endpoint, profile, token = state["hub_url"], state["profile"], state["token"]
    except (OSError, ValueError, KeyError, TypeError):
        raise LoginError(f"cannot read enrollment state {state_file}") from None
    endpoint = validate_hub_url(endpoint)
    if wait:
        payload = _wait_for_approval(
            endpoint,
            token,
            opener=opener,
            sleep=sleep or time.sleep,
            monotonic=monotonic or time.monotonic,
        )
    else:
        status, payload = _request_json(endpoint, "/v1/session", "GET", token, opener=opener)
        if status in {401, 403, 429} or 500 <= status <= 599:
            raise LoginError("not approved yet; open the approval URL, then claim again")
        if status != 200:
            raise LoginError(f"hub returned HTTP {status} while checking approval")
    try:
        _validate_profile_session(_validate_session(payload), token_fingerprint(token), profile)
    except LoginError:
        _revoke(endpoint, token, opener=opener)
        state_file.unlink()
        raise
    return token


def _saved_endpoint(data: Path) -> str:
    prefs = read_json(data / "background.json")
    if isinstance(prefs.get("hub_url"), str) and prefs["hub_url"].strip():
        return validate_hub_url(prefs["hub_url"])
    config = read_json(data / "config.json")
    if isinstance(config.get("hub_url"), str) and config["hub_url"].strip():
        return validate_hub_url(config["hub_url"])
    if "SOMA_HUB_URL" in os.environ:
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
