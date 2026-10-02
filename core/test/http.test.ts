import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHttpHub } from "../src/http.ts";
import type { Row } from "../src/validate.ts";

const TOKEN = "fixture-device-token";
const DATE = "Thu, 01 Jan 2026 00:00:00 GMT";

describe("HTTP hub over a real local server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let destination: ReturnType<typeof Bun.serve>;
  let endpoint: string;
  let requests: string[];
  let redirected: number;
  let release: () => void;
  let started: Promise<void>;
  beforeEach(() => {
    requests = [];
    redirected = 0;
    let notify: () => void;
    started = new Promise<void>((resolve) => { notify = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      redirected++;
      return Response.json({ leaked: true });
    } });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const authorization = request.headers.get("Authorization");
      if (authorization !== `Bearer ${TOKEN}`) {
        return new Response(`<html>Rejected ${authorization}</html>`, { status: 401 });
      }
      if (path.includes("/redirect/")) {
        const status = Number(path.split("/").at(-1));
        return Response.redirect(`${destination.url}stolen`, status);
      }
      if (path === "/v1/same-origin") return Response.redirect(`${server.url}v1/echo`, 307);
      if (path.includes("/status/")) {
        return new Response(`<html>Private response ${TOKEN}</html>`, { status: Number(path.split("/").at(-1)) });
      }
      if (path === "/v1/html") return new Response(`<html>Private ${TOKEN}</html>`, { headers: { "Content-Type": "text/html" } });
      if (path === "/v1/bad-json") return new Response(`{"secret":"${TOKEN}"`, { headers: { "Content-Type": "application/json" } });
      if (path === "/v1/wrong-type") return new Response('{"ok":true}', { headers: { "Content-Type": "text/html" } });
      if (path === "/v1/empty") return new Response(null, { status: 204 });
      if (path === "/v1/null") return Response.json(null);
      if (path === "/v1/pending") { notify!(); await pending; }
      return Response.json({
        method: request.method, authorization, body: await request.json(),
        accept: request.headers.get("Accept"), contentType: request.headers.get("Content-Type"), path,
      }, { headers: { Date: DATE } });
    } });
    endpoint = server.url.toString().replace(/\/$/, "");
  });
  afterEach(async () => {
    release();
    await server.stop(true);
    await destination.stop(true);
  });

  test("posts authenticated JSON through the injected fetch and exposes the server Date", async () => {
    const hub = createHttpHub(`${endpoint}/base///`, TOKEN, fetch);
    expect(hub.endpoint).toBe(`${endpoint}/base`);
    const body = { table: "items", rows: [{ id: "row-1", value: null }], limit: 2 };
    expect(await hub.post("/v1/echo", body)).toEqual({ data: {
      method: "POST", authorization: `Bearer ${TOKEN}`, body,
      accept: "application/json", contentType: "application/json", path: "/base/v1/echo",
    }, date: DATE });
    expect(requests).toEqual(["/base/v1/echo"]);
  });

  test.each([301, 302, 303, 307, 308])("refuses HTTP %i redirects before contacting the destination", async (status) => {
    const hub = createHttpHub(endpoint, TOKEN, fetch);
    await expect(hub.post(`/v1/redirect/${status}`, {})).rejects.toThrow("hub request failed");
    expect(redirected).toBe(0);
    expect(requests).toEqual([`/v1/redirect/${status}`]);
  });

  test("refuses even same-origin redirects", async () => {
    await expect(createHttpHub(endpoint, TOKEN, fetch).post("/v1/same-origin", {}))
      .rejects.toThrow("hub request failed");
    expect(requests).toEqual(["/v1/same-origin"]);
  });

  test.each([401, 403, 429, 500])("reports only HTTP %i, without response HTML or tokens", async (status) => {
    const hub = createHttpHub(endpoint, TOKEN, fetch);
    try {
      await hub.post(`/v1/status/${status}`, {});
      throw new Error("expected HTTP failure");
    } catch (error) {
      expect((error as Error).message).toBe(`hub HTTP ${status}`);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test("a rejected credential is never echoed from the auth error body", async () => {
    await expect(createHttpHub(endpoint, "fixture-wrong-token", fetch).post("/v1/echo", {}))
      .rejects.toThrow(/^hub HTTP 401$/);
  });

  test.each(["html", "bad-json", "wrong-type", "empty"])("rejects the %s protocol failure safely", async (route) => {
    try {
      await createHttpHub(endpoint, TOKEN, fetch).post(`/v1/${route}`, {});
      throw new Error("expected JSON failure");
    } catch (error) {
      expect((error as Error).message).toMatch(/^hub (invalid JSON response|response is not JSON)$/);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test("leaves JSON payload shape validation to the caller", async () => {
    const result = await createHttpHub(endpoint, TOKEN, fetch).post("/v1/null", {});
    expect(result.data).toBeNull();
  });

  test("platform cancellation works through fetch injection without a core timer", async () => {
    const controller = new AbortController();
    const hub = createHttpHub(endpoint, TOKEN, (url, init) => fetch(url, { ...init, signal: controller.signal }));
    // Bun's async matcher waits synchronously; attach it only after aborting.
    const request = hub.post("/v1/pending", {}).catch((error: Error) => error);
    await started;
    controller.abort(new Error(`private cancellation reason: ${TOKEN}`));
    const error = await request;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("hub request failed");
    expect((error as Error).cause).toBeUndefined();
  });

  test("transport failures cannot expose the injected fetch error or cause", async () => {
    const hub = createHttpHub(endpoint, TOKEN, async () => { throw new Error(`private ${TOKEN}`); });
    try {
      await hub.post("/v1/echo", {});
      throw new Error("expected network failure");
    } catch (error) {
      expect((error as Error).message).toBe("hub request failed");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test("serialization failures are safe and never issue a request", async () => {
    const hub = createHttpHub(endpoint, TOKEN, fetch);
    const circular: Row = {};
    circular.self = circular;
    for (const body of [circular, { toJSON() { throw new Error(TOKEN); } }, { value: 1n }, null, [], undefined]) {
      await expect(hub.post("/v1/echo", body as Row)).rejects.toThrow(/^invalid hub request body$/);
    }
    expect(requests).toEqual([]);
  });

  test("rejects routes that could escape the endpoint before sending credentials", async () => {
    const hub = createHttpHub(`${endpoint}/base`, TOKEN, fetch);
    for (const route of ["https://other.test/v1/echo", "//other.test", "/../echo", "/%2e%2e/echo", "/v1/echo?x=y", "/v1/echo#x", "/\\other.test", "echo", "", null, 1]) {
      await expect(hub.post(route as string, {})).rejects.toThrow(/^invalid hub route$/);
    }
    expect(requests).toEqual([]);
    expect(redirected).toBe(0);
  });
});

describe("HTTP hub endpoint validation", () => {
  test.each([
    ["https://HUB.example.test:443/base///", "https://hub.example.test/base"],
    ["http://localhost:8080/", "http://localhost:8080"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
    ["http://127.0.0.2:8080/", "http://127.0.0.2:8080"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
  ])("canonicalizes safe endpoint %s", (url, expected) => {
    expect(createHttpHub(url, TOKEN, fetch).endpoint).toBe(expected);
  });

  test.each([
    "http://hub.example.test", "http://localhost.evil.test", "http://192.0.2.1",
    "ftp://hub.example.test", "file:///tmp/fixture", "//hub.example.test", "https:hub.example.test",
    "https://fixture:secret@hub.example.test", "https://fixture@hub.example.test", "https://@hub.example.test",
    "https://hub.example.test?token=secret", "https://hub.example.test#secret",
    "https://hub.example.test?", "https://hub.example.test#", "https://hub.example.test:70000",
    " https://hub.example.test", "https://hub.example.test/white space", "https://hub.example.test\n",
    "https://hub.example.test\\@other.test", "https:////hub.example.test", "", null, 1,
  ])("rejects unsafe endpoint %j without reflecting it in the error", (url) => {
    expect(() => createHttpHub(url as string, TOKEN, fetch)).toThrow(/^invalid hub endpoint$/);
  });

  test.each(["", "fixture\r\nInjected: yes", "two words", "\u0080", null, 123])(
    "rejects invalid token %j without reflecting it", (token) => {
      expect(() => createHttpHub("https://hub.example.test", token as string, fetch))
        .toThrow(/^invalid hub token$/);
    },
  );

  test("requires an explicit fetch implementation", () => {
    expect(() => createHttpHub("https://hub.example.test", TOKEN, undefined as unknown as typeof fetch))
      .toThrow(/^hub fetch implementation required$/);
  });
});
