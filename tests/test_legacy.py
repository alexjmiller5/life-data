"""Installations made before the rename keep working without re-enrollment."""

import hashlib
import json

import pytest

import soma
from soma import DEFAULT_HUB_URL, HttpHub, credentials, init, legacy, load_config, sync
from soma.background import keychain_account


def test_moves_the_pre_rename_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.delenv("SOMA_DATA_DIR", raising=False)
    old = tmp_path / "life-data"
    init(old / "life.db")
    (old / "life.db-wal").write_text("wal")
    (old / "background.json").write_text('{"enabled": true}')
    assert soma.main(["path"]) == 0
    new = tmp_path / "soma"
    assert (new / "soma.db").exists()
    assert (new / "soma.db-wal").read_text() == "wal"
    assert json.loads((new / "background.json").read_text()) == {"enabled": True}
    assert not old.exists()


def test_existing_data_dir_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.delenv("SOMA_DATA_DIR", raising=False)
    init(tmp_path / "life-data" / "life.db")
    init(tmp_path / "soma" / "soma.db")
    assert soma.main(["path"]) == 0
    assert (tmp_path / "life-data" / "life.db").exists()


def test_keeps_files_already_present_in_the_new_dir(tmp_path, monkeypatch):
    # Home Manager writes the new dir's config.json before the CLI first runs.
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.delenv("SOMA_DATA_DIR", raising=False)
    init(tmp_path / "life-data" / "life.db")
    (tmp_path / "life-data" / "config.json").write_text('{"old": 1}')
    (tmp_path / "soma").mkdir()
    (tmp_path / "soma" / "config.json").write_text('{"new": 1}')
    assert soma.main(["path"]) == 0
    assert (tmp_path / "soma" / "soma.db").exists()
    assert json.loads((tmp_path / "soma" / "config.json").read_text()) == {"new": 1}


def test_hosted_hub_url_follows_the_rename(tmp_path):
    (tmp_path / "background.json").write_text(json.dumps({"hub_url": legacy.HUB_URL}))
    assert load_config(tmp_path, resolve_auth=False)["hub_url"] == DEFAULT_HUB_URL
    saved = json.loads((tmp_path / "background.json").read_text())
    assert saved["hub_url"] == DEFAULT_HUB_URL


def test_self_hosted_hub_url_is_untouched(tmp_path):
    (tmp_path / "background.json").write_text(json.dumps({"hub_url": "https://hub.example"}))
    assert load_config(tmp_path, resolve_auth=False)["hub_url"] == "https://hub.example"


def test_replica_bound_to_the_old_hostname_rebinds(tmp_path, monkeypatch):
    path = init(tmp_path / "soma.db")
    soma._set_state(path, "hub_url", legacy.HUB_URL)
    hub = HttpHub(DEFAULT_HUB_URL)

    class Reached(Exception):
        pass

    def ensure_ready():
        raise Reached

    monkeypatch.setattr(hub, "ensure_ready", ensure_ready)
    with pytest.raises(Reached):
        sync(path, hub)
    assert soma._get_state(path, "hub_url") == DEFAULT_HUB_URL


def test_device_token_moves_to_the_new_keychain_service(tmp_path, monkeypatch):
    items = {}
    monkeypatch.setattr(
        credentials,
        "read_token",
        lambda account, interactive=True, service=credentials._SERVICE: items.get(
            (service, account)
        ),
    )
    monkeypatch.setattr(
        credentials,
        "store_token",
        lambda account, token, service=credentials._SERVICE: items.__setitem__(
            (service, account), token
        ),
    )
    monkeypatch.setattr(
        credentials,
        "delete_token",
        lambda account, service=credentials._SERVICE: items.pop((service, account), None),
    )
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    data = tmp_path / "soma"
    data.mkdir()
    (data / "background.json").write_text(json.dumps({"keychain": True}))
    old_dir = (tmp_path / "life-data").resolve()
    old_account = hashlib.sha256(f"{old_dir}\n{legacy.HUB_URL}".encode()).hexdigest()
    items[("life-data", old_account)] = "device-token"
    assert load_config(data)["token"] == "device-token"
    assert items == {("soma", keychain_account(data, DEFAULT_HUB_URL)): "device-token"}
