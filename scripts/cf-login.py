#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Converge the Cloudflare Access application for Life device enrollment.

This owns only the Access application at ``<domain>/login``. It never creates
or stores a client credential. Pass the operator API token through
``CLOUDFLARE_API_TOKEN`` and use ``--dry-run`` before making a change.
"""

import argparse
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

API = "https://api.cloudflare.com/client/v4"
SESSION = "24h"


class ApiError(RuntimeError):
    pass


class Response:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return json.loads(self._body)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise ApiError(f"HTTP {self.status_code}")


class Client:
    def __init__(self, headers, timeout):
        self.headers = headers
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def request(self, method, url, *, params=None, body=None):
        if params:
            url = f"{url}?{urlencode(params)}"
        request = urllib.request.Request(
            url,
            method=method,
            headers={**self.headers, "Content-Type": "application/json"},
            data=json.dumps(body).encode() if body is not None else None,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return Response(response.status, response.read())
        except urllib.error.HTTPError as exc:
            return Response(exc.code, exc.read())
        except urllib.error.URLError as exc:
            raise ApiError("Cloudflare API request failed") from exc

    def get(self, url, *, params=None):
        return self.request("GET", url, params=params)

    def post(self, url, *, json=None):
        return self.request("POST", url, body=json)

    def put(self, url, *, json=None):
        return self.request("PUT", url, body=json)


def unwrap(response: Response):
    try:
        response.raise_for_status()
        body = response.json()
    except (ApiError, ValueError) as exc:
        raise RuntimeError("Cloudflare API request failed") from exc
    if not body.get("success"):
        raise RuntimeError("Cloudflare API rejected the request")
    return body.get("result")


def paged_get(client: Client, path: str) -> list[dict]:
    values = []
    page = 1
    while True:
        response = client.get(f"{API}{path}", params={"page": page, "per_page": 100})
        result = unwrap(response)
        if not isinstance(result, list):
            raise TypeError("Cloudflare returned an invalid list")
        values.extend(result)
        info = response.json().get("result_info") or {}
        if not info.get("has_more") and len(result) < 100:
            return values
        if info.get("total_pages") and page >= info["total_pages"]:
            return values
        page += 1


def destination(domain: str) -> str:
    parsed = urlparse(domain)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("--domain must be an origin such as https://life.example.com")
    return domain.rstrip("/") + "/login"


def desired_app(name: str, domain: str, emails: list[str], idp: str) -> dict:
    return {
        "name": name,
        "type": "self_hosted",
        "destinations": [{"type": "public", "uri": destination(domain)}],
        "session_duration": SESSION,
        "allowed_idps": [idp],
        "auto_redirect_to_identity": True,
        "app_launcher_visible": False,
        "policies": [
            {
                "name": f"{name} allowed email",
                "decision": "allow",
                "include": [{"email": {"email": email}} for email in emails],
            }
        ],
    }


def drifted(want: dict, have: dict) -> bool:
    fields = (
        "name",
        "session_duration",
        "allowed_idps",
        "auto_redirect_to_identity",
        "app_launcher_visible",
    )
    if any(want[field] != have.get(field) for field in fields):
        return True
    if [item["uri"] for item in want["destinations"]] != [
        item.get("uri") for item in have.get("destinations") or []
    ]:
        return True
    return [(policy["decision"], policy["include"]) for policy in want["policies"]] != [
        (policy.get("decision"), policy.get("include")) for policy in have.get("policies") or []
    ]


def converge(client: Client, account: str, want: dict, dry_run: bool) -> dict:
    apps = paged_get(client, f"/accounts/{account}/access/apps")
    matches = [app for app in apps if app.get("name") == want["name"]]
    if len(matches) > 1:
        raise RuntimeError(f"multiple Access applications named {want['name']!r}")
    if not matches:
        if dry_run:
            return {"action": "create", "aud": None}
        result = unwrap(client.post(f"{API}/accounts/{account}/access/apps", json=want))
        return {"action": "created", "aud": result.get("aud") if isinstance(result, dict) else None}
    existing = matches[0]
    if not drifted(want, existing):
        return {"action": "unchanged", "aud": existing.get("aud")}
    if dry_run:
        return {"action": "update", "aud": existing.get("aud")}
    # Access owns the audience tag. Supplying the existing value avoids
    # accidentally changing the audience when another field is reconciled.
    update = {**want, "aud": existing.get("aud")}
    result = unwrap(
        client.put(f"{API}/accounts/{account}/access/apps/{existing['id']}", json=update)
    )
    return {"action": "updated", "aud": result.get("aud", existing.get("aud"))}


def account_id(client: Client) -> str:
    explicit = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if explicit:
        return explicit
    accounts = unwrap(client.get(f"{API}/accounts"))
    if not isinstance(accounts, list) or len(accounts) != 1:
        raise RuntimeError("set CLOUDFLARE_ACCOUNT_ID when more than one account is visible")
    return accounts[0]["id"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--domain", required=True, help="hub origin, such as https://life.example.com"
    )
    parser.add_argument("--email", action="append", required=True, dest="emails")
    parser.add_argument("--name", default="life-login")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise SystemExit("CLOUDFLARE_API_TOKEN is required")
    with Client(headers={"Authorization": f"Bearer {token}"}, timeout=30) as client:
        account = account_id(client)
        idps = paged_get(client, f"/accounts/{account}/access/identity_providers")
        idp = next((item["id"] for item in idps if item.get("type") == "onetimepin"), None)
        if not idp:
            raise SystemExit("the account has no email OTP identity provider")
        result = converge(
            client, account, desired_app(args.name, args.domain, args.emails, idp), args.dry_run
        )
    print(f"{result['action']}: {args.name}")
    if result["aud"]:
        print(f"LOGIN_ACCESS_AUD={result['aud']}")
    elif result["action"] in {"create", "update"}:
        print("Access audience is available after the app is created.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
