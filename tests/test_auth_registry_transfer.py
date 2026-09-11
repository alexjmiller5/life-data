import importlib.util
from pathlib import Path

import pytest


def module():
    path = Path(__file__).parents[1] / "scripts" / "migrate-auth-registry.py"
    spec = importlib.util.spec_from_file_location("migrate_auth_registry", path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def row(**overrides):
    value = {
        "hash": "h",
        "name": "device:h",
        "scopes": "full",
        "created_at": "2026-09-11T00:00:00.000Z",
        "revoked_at": None,
        "last_used_at": None,
        "label": "Mac",
    }
    return value | overrides


def test_transfer_is_idempotent_and_does_not_overwrite_existing_rows():
    script = module()
    source = [row()]
    assert script.pending_rows(source, []) == source
    assert script.pending_rows(source, source) == []


def test_transfer_rejects_conflicting_hash_or_name():
    script = module()
    with pytest.raises(ValueError, match="conflicting"):
        script.pending_rows([row(scopes="tables:read")], [row()])


def test_table_exists_uses_d1_compatible_pragma(monkeypatch):
    script = module()
    calls = []

    def fake_query(_client, account, database, sql, params=()):
        calls.append((account, database, sql, params))
        return [{"name": "_tokens"}]

    monkeypatch.setattr(script, "query", fake_query)

    assert script.table_exists(object(), "account", "database", "_tokens") is True
    assert calls == [("account", "database", "PRAGMA table_info(_tokens)", ())]
