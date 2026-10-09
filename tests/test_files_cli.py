import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from soma import HttpHub, main

LISTING = json.loads((Path(__file__).parent / "fixtures" / "hub-files-contract.json").read_text())[
    "listing"
]["body"]


def test_files_list_follows_every_cursor_and_prints_all_objects(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", "https://hub.example")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "lt_fixture")
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


def test_files_rm_needs_yes_and_sends_one_encoded_delete(tmp_path, monkeypatch, capsys):
    import io

    import soma

    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", "https://hub.example")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "lt_fixture")
    calls = []

    def fake_open(url, headers, *, opener, timeout, data=None, method=None):
        calls.append((method, url))
        return io.BytesIO(b'{"key": "k", "bytes": 4, "etag": "\\"e\\""}')

    monkeypatch.setattr(soma, "_open_hub_request", fake_open)
    assert main(["files", "rm", "raw/a b.json"]) == 1
    assert "--yes" in capsys.readouterr().err
    assert calls == []
    assert main(["files", "rm", "raw/a b.json", "--yes"]) == 0
    assert json.loads(capsys.readouterr().out) == {"key": "k", "bytes": 4, "etag": '"e"'}
    assert main(["files", "rm", "__r2_data_catalog/ns/t/m.json", "--yes", "--catalog"]) == 0
    assert calls == [
        ("DELETE", "https://hub.example/v1/files/raw/a%20b.json"),
        ("DELETE", "https://hub.example/v1/files/__r2_data_catalog/ns/t/m.json?catalog=1"),
    ]
