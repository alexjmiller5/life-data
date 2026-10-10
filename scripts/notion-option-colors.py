#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# ///
"""Copy Notion select/status option colors onto migrated catalog options.

One-off, idempotent backfill for estates migrated from Notion databases. Input
is a JSON map of soma table -> Notion data source ids (the operator's own
mapping, never committed):

    {"tasks": ["<data-source-id>"], "things_to_do": ["<id-a>", "<id-b>"]}

Each select/multi_select property of a mapped table is paired with the Notion
select, multi_select or status property of the same name (snake_case, a
`legacy_` prefix ignored, else the Notion property sharing the most option
names, at least two or half of them). Its options whose value equals a Notion option name (exact, then
case-insensitive) get that option's color; other options are left as they are.
Changes go through `soma property set --options`, the logged catalog edit path.
`--dry-run` prints the mapping and writes nothing.

    uv run scripts/notion-option-colors.py --map map.json --dry-run
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

COLORS = {"default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}
CHOICE_TYPES = ("select", "multi_select", "status")


def run(*cmd: str) -> str:
    # ntn blocks on an inherited non-TTY stdin
    return subprocess.run(
        cmd, check=True, capture_output=True, text=True, stdin=subprocess.DEVNULL
    ).stdout


def snake(name: str) -> str:
    name = re.sub(r"\(.*?\)", "", name)
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def notion_choices(data_source_ids: list[str]) -> dict[str, dict[str, str]]:
    """Notion property name -> {option name: color}, first data source wins."""
    found: dict[str, dict[str, str]] = {}
    for ds in data_source_ids:
        schema = json.loads(run("ntn", "api", f"v1/data_sources/{ds}"))
        for name, prop in schema["properties"].items():
            if prop["type"] in CHOICE_TYPES:
                colors = found.setdefault(name, {})
                for option in prop[prop["type"]]["options"]:
                    colors.setdefault(option["name"], option["color"])
    return found


def pair(col: str, values: set[str], choices: dict[str, dict[str, str]]) -> tuple[str, str] | None:
    """(Notion property, how) for a soma column, or None."""
    want = col.removeprefix("legacy_")
    for name in choices:
        if snake(name) == want:
            return name, "name"
    overlap = {name: len(values & set(colors)) for name, colors in choices.items()}
    best = max(overlap, key=overlap.get, default=None)
    # a lone shared generic word ("Other") is not a pairing
    hits = overlap.get(best, 0)
    return (best, "overlap") if hits >= 2 or hits and 2 * hits >= len(values) else None


def recolor(options: list[dict], colors: dict[str, str]) -> tuple[list[dict], int]:
    folded = {k.casefold(): v for k, v in colors.items()}
    out, matched = [], 0
    for option in options:
        color = colors.get(option["v"]) or folded.get(option["v"].casefold())
        if color in COLORS:
            option = {**option, "color": color}
            matched += 1
        out.append(option)
    return out, matched


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--map", required=True, help="JSON file: {table: [notion data source id, ...]}")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    mapping: dict[str, list[str]] = json.loads(Path(args.map).read_text())
    report = []
    for table, sources in mapping.items():
        choices = notion_choices(sources)
        for prop in json.loads(run("soma", "property", "list", table)):
            if prop.get("type") not in ("select", "multi_select") or not prop.get("options"):
                continue
            options = prop["options"]
            match = pair(prop["col"], {o["v"] for o in options}, choices)
            if not match:
                report.append({"property": prop["id"], "notion": None})
                continue
            updated, matched = recolor(options, choices[match[0]])
            changed = updated != options
            entry = {
                "property": prop["id"],
                "notion": match[0],
                "paired_by": match[1],
                "options": len(options),
                "colored": matched,
                "changed": changed,
            }
            if changed and not args.dry_run:
                try:
                    run("soma", "property", "set", prop["id"], "--options", json.dumps(updated))
                except subprocess.CalledProcessError as e:
                    entry["error"] = (e.stderr or e.stdout).strip()[-500:]
            report.append(entry)
    json.dump(report, sys.stdout, indent=1)
    print()
    return 1 if any("error" in r for r in report) else 0


if __name__ == "__main__":
    sys.exit(main())
