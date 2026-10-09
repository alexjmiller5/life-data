"""Large replica reads must cross the HTTP boundary in bounded pages."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from soma import HttpHub


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


def serve(replies):
    """A hub that answers each request with the next scripted (status, body);
    a None status drops the connection without any response."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            status, body = replies.pop(0)
            if status is None:
                self.close_connection = True
                return
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, requests, HttpHub(f"http://127.0.0.1:{server.server_port}")


@pytest.fixture
def waits(monkeypatch):
    import soma

    delays = []
    monkeypatch.setattr(soma.time, "sleep", delays.append)
    return delays


def test_http_pull_retries_transient_page_failures(waits):
    server, requests, hub = serve(
        [
            (200, {"rows": [{"id": "a"}], "next_cursor": "a"}),
            (500, {"error": "D1_ERROR: storage operation exceeded timeout"}),
            (None, None),
            (200, {"rows": [{"id": "b"}], "next_cursor": None}),
        ]
    )
    try:
        assert hub.rows_pull("records", ["id"], "") == [{"id": "a"}, {"id": "b"}]
    finally:
        server.shutdown()
    assert [r.get("after") for r in requests] == [None, "a", "a", "a"]
    assert len(waits) == 2


def test_http_push_retries_a_transient_chunk_failure(waits):
    server, requests, hub = serve(
        [(503, {"error": "busy"}), (200, {"upserted": 1, "rejected": []})]
    )
    try:
        out = hub.rows_push("records", ["id", "updated_at"], [{"id": "a", "updated_at": "x"}])
    finally:
        server.shutdown()
    assert out == {"upserted": 1, "rejected": []}
    assert len(requests) == 2 and len(waits) == 1


@pytest.mark.parametrize(("status", "attempts"), [(400, 1), (500, 4)])
def test_http_pull_gives_up_on_client_errors_and_persistent_failures(waits, status, attempts):
    server, requests, hub = serve([(status, {"error": "boom"})] * 5)
    try:
        with pytest.raises(RuntimeError, match=f"hub HTTP {status}: .*boom"):
            hub.rows_pull("records", ["id"], "")
    finally:
        server.shutdown()
    assert len(requests) == attempts


def test_http_push_halves_rows_the_hub_could_not_fit():
    """write-budget rejections ask for a smaller batch: halve until one row alone fails."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            rows = body["rows"]
            over = len(rows) > 2
            budget = {"rule": "write-budget", "retryable": True, "col": None, "message": "smaller"}
            rejected = [{"id": r["id"], **budget} for r in rows if over or r["id"] == "row-3"] + [
                {"id": r["id"], "rule": "type", "col": "x", "message": "bad"}
                for r in rows
                if not over and r["id"] == "row-5"
            ]
            data = json.dumps(
                {"upserted": len(rows) - len(rejected), "rejected": rejected}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    hub = HttpHub(f"http://127.0.0.1:{server.server_address[1]}")
    rows = [{"id": f"row-{i}", "updated_at": "t"} for i in range(8)]
    history = [{"id": f"h-{i}", "row_id": f"row-{i}"} for i in range(8)]
    try:
        out = hub.rows_push("records", ["id", "updated_at"], rows, history=history)
    finally:
        server.shutdown()
    assert out["upserted"] == 6
    assert sorted((r["id"], r["rule"]) for r in out["rejected"]) == [
        ("row-3", "write-budget"),
        ("row-5", "type"),
    ]
    assert max(len(r["rows"]) for r in requests[1:]) <= 4
    for body in requests:
        ids = {r["id"] for r in body["rows"]}
        assert {e["row_id"] for e in body.get("history", [])} == ids
