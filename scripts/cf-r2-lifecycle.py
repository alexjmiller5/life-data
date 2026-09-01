#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Ensure the backup bucket's tiered retention. Idempotent: this script IS the
source of truth for how long each backup tier lives.

R2 lifecycle rules can only expire a whole prefix by age, so grandfather-
father-son retention comes from the Worker writing each copy into the prefix
whose rule matches its intended lifetime:

    daily/    every day        -> 35 days   (any single day in the last month)
    weekly/   Sundays          -> 190 days  (~27 points across six months)
    monthly/  the 1st          -> 400 days  (13 points across a year)
    yearly/   Jan 1            -> kept forever

Usage:
    ./scripts/cf-r2-lifecycle.py [--bucket NAME] [--dry-run]

Credentials: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment
(the token needs R2 write).
"""

import argparse
import json
import os
import sys

import httpx

TIERS = [
    ("daily/", 35),
    ("weekly/", 190),
    ("monthly/", 400),
    ("yearly/", None),  # never expires
]


def rules() -> list[dict]:
    out = []
    for prefix, days in TIERS:
        if days is None:
            continue
        out.append(
            {
                "id": f"expire-{prefix.rstrip('/')}",
                "enabled": True,
                "conditions": {"prefix": prefix},
                "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": days * 86400}},
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", default="life-data-backups")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        print("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set", file=sys.stderr)
        return 2

    body = {"rules": rules()}
    if args.dry_run:
        print(json.dumps(body, indent=2))
        return 0

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/r2/buckets/{args.bucket}/lifecycle"
    )
    resp = httpx.put(url, json=body, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    payload = resp.json()
    if not payload.get("success"):
        print(json.dumps(payload.get("errors"), indent=2), file=sys.stderr)
        return 1
    for prefix, days in TIERS:
        print(f"{prefix:<10} {'kept forever' if days is None else f'expires after {days}d'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
