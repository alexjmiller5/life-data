"""User controls and the supervised background sync loop."""

import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
from datetime import UTC, datetime
from pathlib import Path


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-")
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out)
            out.write("\n")
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def keychain_account(data: Path, hub_url: str) -> str:
    return hashlib.sha256(f"{data.resolve()}\n{hub_url.rstrip('/')}".encode()).hexdigest()


def status(data: Path) -> dict:
    prefs = read_json(data / "background.json")
    current = read_json(data / "background-status.json")
    running = False
    try:
        with (data / "background.lock").open("r") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                running = True
                if sys.platform == "darwin":
                    pid = lock.read().strip()
                    if pid.isdigit():
                        proc = subprocess.run(
                            ["/bin/ps", "-o", "state=", "-p", pid],
                            capture_output=True,
                            text=True,
                            timeout=2,
                            check=False,
                        )
                        running = proc.returncode == 0 and not any(
                            state in proc.stdout for state in ("T", "Z")
                        )
    except FileNotFoundError:
        pass
    return {
        "enabled": prefs.get("enabled", False),
        "running": running,
        "state": current.get("state", "starting") if running else "stopped",
        "last_success": current.get("last_success"),
        "last_error": current.get("last_error"),
        "last_attempt": current.get("last_attempt"),
        "stats": current.get("stats"),
    }


def command(args, data: Path) -> int:
    from . import _get_state, load_config

    action = args.background_command
    if action == "run":
        return run(data, args.poll)
    if action in {"enable", "disable"}:
        prefs = read_json(data / "background.json")
        if action == "enable":
            if args.hub_url:
                previous = load_config(data, resolve_auth=False)["hub_url"]
                endpoint = os.environ.get("LIFE_HUB_URL", args.hub_url).rstrip("/")
                db = data / "life.db"
                if (
                    endpoint != previous
                    and db.exists()
                    and (_get_state(db, "last_push") or _get_state(db, "last_pull"))
                ):
                    raise ValueError("hub changed; use a fresh data directory for a different hub")
                prefs["hub_url"] = args.hub_url.rstrip("/")
            if args.token_command is not None:
                if not args.token_command.strip():
                    raise ValueError("credential command must not be empty")
                prefs["token_cmd"] = args.token_command
                prefs.pop("keychain", None)
            if args.token_stdin:
                from .credentials import store_token

                cfg = load_config(data, resolve_auth=False)
                endpoint = os.environ.get(
                    "LIFE_HUB_URL", prefs.get("hub_url", cfg["hub_url"])
                ).rstrip("/")
                try:
                    if sys.stdin.isatty():
                        import getpass

                        token = getpass.getpass("Life device token: ")
                    else:
                        token = sys.stdin.read().strip()
                    store_token(keychain_account(data, endpoint), token)
                except RuntimeError as exc:
                    print(str(exc), file=sys.stderr)
                    return 1
                prefs["hub_url"] = endpoint
                prefs["keychain"] = True
                prefs.pop("token_cmd", None)
        prefs["enabled"] = action == "enable"
        prefs["revision"] = prefs.get("revision", 0) + 1
        write_json(data / "background.json", prefs)
    print(json.dumps(status(data)))
    return 0


def _stamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _credential(data: Path, cfg: dict, prefs: dict) -> str:
    # Background auth is independent from the interactive token command.
    if token := os.environ.get("LIFE_HUB_TOKEN"):
        return token
    if prefs.get("keychain"):
        from .credentials import read_token

        return read_token(keychain_account(data, cfg["hub_url"])) or ""
    cmd = prefs.get("token_cmd", cfg.get("background_token_cmd"))
    if cmd:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=30, check=False
        )
        if result.returncode:
            raise RuntimeError("credential command failed")
        token = result.stdout.strip()
        if "\n" in token or "\r" in token:
            raise RuntimeError("credential command returned an invalid token")
        return token
    return ""


def run(data: Path, poll_seconds: int) -> int:
    """Stay supervised while disabled; never authenticate until opted in."""
    from . import db_changed, db_version, hub_from_config, init, load_config, sync

    data.mkdir(parents=True, exist_ok=True)
    with (data / "background.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("background sync is already running", file=sys.stderr)
            return 1
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()
        current = read_json(data / "background-status.json")
        saved_status = None
        path = data / "life.db"
        hub = None
        previous_config = None
        fingerprint = db_version(path)
        next_sync = 0.0
        retry = 60
        while True:
            try:
                prefs = read_json(data / "background.json")
                if not prefs.get("enabled", False):
                    hub = None
                    previous_config = None
                    next_sync = 0.0
                    retry = 60
                    current["state"] = "disabled"
                else:
                    cfg = load_config(data, resolve_auth=False)
                    signature = (cfg, prefs)
                    changed, fingerprint = db_changed(path, fingerprint)
                    if signature != previous_config:
                        hub = None
                        next_sync = 0.0
                        retry = 60
                        previous_config = signature
                    due = time.monotonic() >= next_sync
                    if due or (changed and hub and current.get("state") == "idle"):
                        current.update(state="syncing", last_attempt=_stamp())
                        write_json(data / "background-status.json", current)
                        if hub is None:
                            token = _credential(data, cfg, prefs)
                            if not token:
                                raise RuntimeError("no background credential configured")
                            hub = hub_from_config({**cfg, "token": token})
                        init(path)
                        stats = sync(path, hub)
                        current["stats"] = {k: v for k, v in stats.items() if k != "rejected"}
                        current["stats"]["rejected"] = len(stats.get("rejected", []))
                        if stats.get("rejected"):
                            raise RuntimeError("hub rejected rows")
                        current.update(state="idle", last_success=_stamp(), last_error=None)
                        fingerprint = db_version(path)
                        retry = 60
                        next_sync = time.monotonic() + poll_seconds
            except Exception as exc:  # noqa: BLE001 - stay alive through outages
                # Exception messages/remote bodies can contain credentials or data.
                http_error = exc if isinstance(exc, urllib.error.HTTPError) else exc.__cause__
                if isinstance(http_error, urllib.error.HTTPError):
                    error = f"HTTP {http_error.code}"
                    if http_error.code in {401, 403}:
                        hub = None
                elif (
                    isinstance(exc, RuntimeError)
                    and str(exc)
                    in {
                        "no background credential configured",
                        "credential command failed",
                        "credential command returned an invalid token",
                        "hub rejected rows",
                    }
                    or isinstance(exc, ValueError)
                    and str(exc).startswith("hub changed;")
                ):
                    error = str(exc)
                else:
                    error = type(exc).__name__
                current.update(state="retrying", last_error=error)
                next_sync = time.monotonic() + retry
                retry = min(retry * 2, 3600)
            if current != saved_status:
                write_json(data / "background-status.json", current)
                saved_status = current.copy()
            time.sleep(1)
