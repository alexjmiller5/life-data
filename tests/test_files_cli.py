import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from life_data import HttpHub, main

LISTING = json.loads((Path(__file__).parent / "fixtures" / "hub-files-contract.json").read_text())[
    "listing"
]["body"]


def test_files_list_follows_every_cursor_and_prints_all_objects(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LIFE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LIFE_HUB_URL", "https://hub.example")
    monkeypatch.setenv("LIFE_HUB_TOKEN", "lt_fixture")
    second = {**LISTING["objects"][0], "key": "captures/later.html"}
    pages = [{**LISTING, "cursor": "opaque/1"}, {"objects": [second], "cursor": None}]
    routes = []

    def get(self, route):
        routes.append(route)
        return pages[len(routes) - 1]

    monkeypatch.setattr(HttpHub, "_get", get)
    assert main(["files", "list", "captures/"]) == 0
    assert json.loads(capsys.readouterr().out) == [LISTING["objects"][0], second]
    queries = [parse_qs(urlparse(r).query) for r in routes]
    assert [urlparse(r).path for r in routes] == ["/v1/files", "/v1/files"]
    assert queries == [
        {"prefix": ["captures/"], "limit": ["1000"]},
        {"prefix": ["captures/"], "limit": ["1000"], "cursor": ["opaque/1"]},
    ]
