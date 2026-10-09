"""Adopt an installation made before the project was named Soma.

Such an install kept its data in <data home>/life-data/life.db, synced with
the hosted hub's old hostname and stored its device token under Keychain
service life-data. Each piece moves once, on first use, so devices stay
enrolled.
"""

import hashlib
import os
from pathlib import Path

HUB_URL = "https://life-data.nqipomyrjb.workers.dev"
SERVICE = "life-data"
DB_NAME = "life.db"


def data_dir() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(xdg) / "life-data"


def adopt_data_dir(new: Path) -> None:
    """Move the old default data dir's entries into `new` (life.db* -> soma.db*).

    Entries already present in `new` win: Home Manager writes config.json there
    before the CLI first runs. A dir that already holds a database is never
    touched."""
    old = data_dir()
    if not old.is_dir() or (new / "soma.db").exists():
        return
    new.mkdir(parents=True, exist_ok=True)
    for entry in old.iterdir():
        name = "soma.db" + entry.name[len(DB_NAME) :] if entry.name.startswith(DB_NAME) else None
        target = new / (name or entry.name)
        if target.exists() or target.is_symlink():
            continue
        try:
            entry.rename(target)
        except FileNotFoundError:  # a concurrent first run moved it
            pass
    try:
        old.rmdir()
    except OSError:
        pass


def hub_url(url: str, default: str) -> str:
    """The hosted hub under its current hostname; any other hub is kept."""
    return default if url.rstrip("/") == HUB_URL else url


def adopt_token(data: Path, url: str, default: str, *, interactive: bool) -> str | None:
    """Move a device token stored under the old service, data dir and hostname."""
    from . import credentials
    from .background import keychain_account

    if url.rstrip("/") != default:
        return None
    accounts = {
        hashlib.sha256(f"{path}\n{HUB_URL}".encode()).hexdigest()
        for path in (data.resolve(), data_dir().resolve())
    }
    for account in accounts:
        token = credentials.read_token(account, interactive=interactive, service=SERVICE)
        if token:
            credentials.store_token(keychain_account(data, url), token)
            credentials.delete_token(account, service=SERVICE)
            return token
    return None
