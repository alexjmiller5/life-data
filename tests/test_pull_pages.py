"""Large replica reads must cross the HTTP boundary in bounded pages."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from life_data import HttpHub


def test_http_pull_reads_every_page_including_tombstones():
    rows = [
        {"id": f"row-{i:04}", "deleted_at": "2026-01-01" if i == 201 else None} for i in range(417)
    ]
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            if body.get("limit") != 200:
                self.send_error(500, "unbounded response exceeds service limit")
                return
            page = [r for r in rows if r["id"] > body.get("after", "")][: body["limit"]]
            data = json.dumps(
                {
                    "rows": page,
                    "next_cursor": page[-1]["id"] if len(page) == body["limit"] else None,
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        hub = HttpHub(f"http://127.0.0.1:{server.server_port}")
        assert hub.rows_pull("records", ["id", "deleted_at"], "2026-01-01") == rows
        assert len(requests) == 3
        assert {r["since"] for r in requests} == {"2026-01-01"}
        assert [r.get("after") for r in requests] == [None, "row-0199", "row-0399"]
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


@pytest.mark.parametrize("cursor", ["a", "", 2, ["b"]])
def test_http_pull_rejects_invalid_or_nonadvancing_cursor(monkeypatch, cursor):
    hub = HttpHub("https://hub.example.test")
    replies = iter(
        [
            {"rows": [{"name": "first"}], "next_cursor": "a"},
            {"rows": [{"name": "second"}], "next_cursor": cursor},
        ]
    )
    monkeypatch.setattr(hub, "_post", lambda *_: next(replies))
    with pytest.raises(RuntimeError, match="invalid pull cursor"):
        hub.rows_pull("records", ["name"], "")
