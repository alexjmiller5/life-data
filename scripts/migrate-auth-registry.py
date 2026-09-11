#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Copy the legacy token registry into Life's separate auth D1.

The source is read once and the target is preflighted before any insert. An
existing matching row is accepted; a conflicting hash or name aborts without
overwriting anything. The script is safe to rerun after an interrupted copy.
"""

import argparse
import json as jsonlib
import os
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
SCHEMA = """CREATE TABLE IF NOT EXISTS _tokens (
  hash TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  last_used_at TEXT,
  label TEXT
)"""
FIELDS = ("hash", "name", "scopes", "created_at", "revoked_at", "last_used_at", "label")


def same_row(left: dict, right: dict) -> bool:
    return all(left.get(field) == right.get(field) for field in FIELDS)


def pending_rows(source: list[dict], target: list[dict]) -> list[dict]:
    by_hash = {row["hash"]: row for row in target}
    by_name = {row["name"]: row for row in target}
    pending = []
    for row in source:
        existing = by_hash.get(row["hash"]) or by_name.get(row["name"])
        if existing:
            if not same_row(row, existing):
                raise ValueError("target contains a conflicting auth row")
            continue
        pending.append(row)
        by_hash[row["hash"]] = row
        by_name[row["name"]] = row
    return pending


class ApiError(RuntimeError):
    pass


class Response:
    def __init__(self, status, body):
        self.status = status
        self.body = body

    def json(self):
        return jsonlib.loads(self.body)

    def raise_for_status(self):
        if self.status >= 400:
            raise ApiError(f"HTTP {self.status}")


class Client:
    def __init__(self, headers, timeout):
        self.headers = headers
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def post(self, url, *, json=None):
        request = urllib.request.Request(
            url,
            method="POST",
            headers={**self.headers, "Content-Type": "application/json"},
            data=jsonlib.dumps(json).encode(),
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return Response(response.status, response.read())
        except urllib.error.HTTPError as exc:
            return Response(exc.code, exc.read())
        except urllib.error.URLError as exc:
            raise ApiError("Cloudflare D1 request failed") from exc


def unwrap(response: Response) -> list[dict]:
    try:
        response.raise_for_status()
        body = response.json()
    except (ApiError, ValueError) as exc:
        raise RuntimeError("Cloudflare D1 request failed") from exc
    if not body.get("success"):
        raise RuntimeError("Cloudflare D1 rejected the request")
    result = body.get("result") or []
    if not isinstance(result, list) or not result:
        return []
    first = result[0]
    if not isinstance(first, dict):
        raise TypeError("Cloudflare D1 returned an invalid result")
    return first.get("results") or []


def query(client: Client, account: str, database: str, sql: str, params=()) -> list[dict]:
    return unwrap(
        client.post(
            f"{API}/accounts/{account}/d1/database/{database}/query",
            json={"sql": sql, "params": list(params)},
        )
    )


def table_exists(client: Client, account: str, database: str, table: str) -> bool:
    return bool(query(client, account, database, f"PRAGMA table_info({table})"))


def copy_registry(client: Client, account: str, source: str, target: str) -> int:
    if source == target:
        raise ValueError("source and target databases must differ")
    if not table_exists(client, account, source, "_tokens"):
        return 0
    source_rows = query(
        client,
        account,
        source,
        f"SELECT {', '.join(FIELDS[:-1])}, NULL AS label FROM _tokens ORDER BY name",
    )
    query(client, account, target, SCHEMA)
    target_rows = query(
        client, account, target, f"SELECT {', '.join(FIELDS)} FROM _tokens ORDER BY name"
    )
    rows = pending_rows(source_rows, target_rows)
    for row in rows:
        query(
            client,
            account,
            target,
            "INSERT INTO _tokens (hash, name, scopes, created_at, revoked_at, last_used_at, label) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [row.get(field) for field in FIELDS],
        )
    return len(rows)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--account-id",
        default=os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
        required=not os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
    )
    parser.add_argument("--source-id", required=True, help="existing life-data D1 id")
    parser.add_argument("--target-id", required=True, help="new auth D1 id")
    args = parser.parse_args(argv)
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise SystemExit("CLOUDFLARE_API_TOKEN is required")
    with Client(headers={"Authorization": f"Bearer {token}"}, timeout=30) as client:
        count = copy_registry(client, args.account_id, args.source_id, args.target_id)
    print(f"copied {count} auth rows")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
