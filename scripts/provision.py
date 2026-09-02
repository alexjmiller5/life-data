#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Mint this project's machine-creatable credentials (op-project-bootstrap
provision contract: --list prints mintable field names; --field NAME prints
ONLY the secret to stdout, progress on stderr).

Nothing here should ever be typed by hand. Runs under whatever `op` auth the
caller has; needs read access to the AI Agent vault (the admin CF token).
Idempotent per field.
"""

import argparse
import subprocess
import sys

import httpx

CF_ACCOUNT = "1e69de15e5dc3dddea6db7b3ae8087bc"
NAME = "life-data"
# AI Agent vault items, by ID (names are mutable, IDs aren't)
OP_CF_TOKEN = "op://4eeyrkqibibn7k4j6rz2fbzvxm/mxxpo6neiz3grdyrjj7rv7nume/credential"


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def op_read(ref: str) -> str:
    return subprocess.run(
        ["op", "read", ref], capture_output=True, text=True, check=True
    ).stdout.strip()


def mint_deploy_token() -> str:
    """Project-scoped CF token for CI: Workers Scripts + D1 only.
    Needs 'User API Tokens: Edit' on the AI Agent token. Recreates if it
    already exists (a token's value is only shown at creation)."""
    admin = op_read(OP_CF_TOKEN)
    c = httpx.Client(
        base_url="https://api.cloudflare.com/client/v4",
        headers={"Authorization": f"Bearer {admin}"},
        timeout=30,
    )
    token_name = f"{NAME}-deploy"
    existing = c.get("/user/tokens", params={"per_page": 100}).raise_for_status().json()["result"]
    for t in existing or []:
        if t["name"] == token_name:
            log(f"deleting existing token {token_name} (value not re-readable)")
            c.delete(f"/user/tokens/{t['id']}").raise_for_status()
    log(f"✓ scoped deploy token '{token_name}' minting (Workers Scripts + D1 + Pipelines)")
    groups = c.get("/user/tokens/permission_groups").raise_for_status().json()["result"]
    # Pipelines Write: deploys bind the events stream, which the API checks
    want = {"Workers Scripts Write", "D1 Write", "Pipelines Write"}
    ids = [{"id": g["id"]} for g in groups if g["name"] in want]
    assert len(ids) == len(want), f"permission groups not found: {want}"
    r = c.post(
        "/user/tokens",
        json={
            "name": token_name,
            "policies": [
                {
                    "effect": "allow",
                    "resources": {f"com.cloudflare.api.account.{CF_ACCOUNT}": "*"},
                    "permission_groups": ids,
                }
            ],
        },
    ).raise_for_status()
    log(f"✓ scoped deploy token '{token_name}' minted (Workers Scripts + D1)")
    return r.json()["result"]["value"]


MINTERS = {
    "api-token": mint_deploy_token,
    "account-id": lambda: CF_ACCOUNT,
}


BUCKETS = ["life-data-backups", "life-data-archive"]


def ensure() -> None:
    """Non-secret side effects (safe for agents to run): the service's R2
    buckets exist. wrangler bindings reference them but cannot create them."""
    admin = op_read(OP_CF_TOKEN)
    c = httpx.Client(
        base_url=f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/r2",
        headers={"Authorization": f"Bearer {admin}"},
        timeout=30,
    )
    have = {b["name"] for b in c.get("/buckets").raise_for_status().json()["result"]["buckets"]}
    for name in BUCKETS:
        if name in have:
            log(f"bucket {name}: exists")
        else:
            c.post("/buckets", json={"name": name}).raise_for_status()
            log(f"✓ bucket {name} created")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--field")
    ap.add_argument("--ensure", action="store_true")
    args = ap.parse_args()
    if args.ensure:
        ensure()
        return 0
    if args.list:
        print("\n".join(MINTERS))
        return 0
    if args.field:
        if args.field not in MINTERS:
            log(f"no minter for {args.field}")
            return 1
        print(MINTERS[args.field]())
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
