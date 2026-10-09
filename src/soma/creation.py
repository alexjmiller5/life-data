"""Canonical create-only consumer checks, without an embedded JS runtime.

Conforms with soma-core/creation through the shared wire corpus. Hosts own
transport, credentials and retries. None never proves a prior attempt failed.
"""

import re
from datetime import datetime


def _keys(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _ref(value):
    return (
        _keys(value, ("id", "revision"))
        and _matches(r"[a-z][a-z0-9_-]{0,63}", value["id"])
        and _matches(r"[0-9a-f]{64}", value["revision"])
    )


def _timestamp(value):
    if not _matches(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value):
        return False
    try:
        datetime.fromisoformat(value)
        return True
    except ValueError:
        return False


def validate_creation_receipt(request: dict, reply: dict) -> dict | None:
    """Return a strict receipt for the submitted intent, else indeterminate None."""
    value = reply.get("data")
    if (
        reply.get("status") != 200
        or not isinstance(value, dict)
        or not _ref(value.get("policy"))
        or not _ref(request["policy"])
        or value["policy"] != request["policy"]
        or value.get("id") != request["target"]["id"]
    ):
        return None
    if value.get("kind") == "existing" and _keys(value, ("kind", "policy", "id")):
        return value
    if (
        value.get("kind") != "created"
        or request["target"]["kind"] != "generated"
        or not _keys(value, ("kind", "policy", "id", "revision", "originId"))
        or not _keys(value["revision"], ("updated_at", "hub_at"))
        or value["revision"]["updated_at"] != request["updatedAt"]
        or not _timestamp(value["revision"]["updated_at"])
        or not _timestamp(value["revision"]["hub_at"])
        or not isinstance(value["originId"], str)
    ):
        return None
    suffix = ":" + request["sourceId"] + ":" + request["target"]["id"]
    if not value["originId"].endswith(suffix) or not _matches(
        r"[A-Za-z][A-Za-z0-9_-]{0,63}", value["originId"][: -len(suffix)]
    ):
        return None
    return value


def validate_creation_session(reply: dict, expected: dict, expected_scopes: list[str]) -> bool:
    """Require exactly one current policy and only its explicitly expected grants."""
    value = reply.get("data")
    if reply.get("status") != 200 or not _ref(expected) or not isinstance(value, dict):
        return False
    scopes = value.get("scopes")
    if (
        not isinstance(scopes, list)
        or not isinstance(expected_scopes, list)
        or any(not isinstance(s, str) for s in scopes + expected_scopes)
        or len(scopes) != len(set(scopes))
        or len(expected_scopes) != len(set(expected_scopes))
        or set(scopes) != set(expected_scopes)
    ):
        return False
    grant = f"rows:create:{expected['id']}:{expected['revision']}"
    if grant not in scopes or any(
        s != grant and not _matches(r"tables:read:[A-Za-z][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*", s)
        for s in scopes
    ):
        return False
    capabilities = value.get("capabilities")
    if not isinstance(capabilities, dict) or "governance" in capabilities:
        return False
    creation = capabilities.get("rowCreation")
    return (
        _keys(creation, ("protocol", "policies"))
        and creation["protocol"] == "atomic-origin-v1"
        and isinstance(creation["policies"], list)
        and len(creation["policies"]) == 1
        and _ref(creation["policies"][0])
        and creation["policies"][0] == expected
    )
