import { expect, test } from "bun:test";
import worker, { allowed } from "../src/index.js";
import { D1Shim } from "./d1shim.js";

async function setup(scopes) {
  const objects = new Map();
  const archive = {
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, type: options.httpMetadata.contentType });
      return { httpEtag: '"etag"' };
    },
    async get(key) {
      const obj = objects.get(key);
      return obj && { body: obj.bytes, size: obj.bytes.length,
        writeHttpMetadata(headers) { headers.set("Content-Type", obj.type); } };
    },
    async head(key) { return this.get(key); },
  };
  const env = { HUB_TOKEN: "root", DB: new D1Shim(), AUTH_DB: new D1Shim(), ARCHIVE: archive };
  const ctx = { waitUntil() {} };
  const created = await worker.fetch(new Request("https://hub.test/v1/tokens/create", {
    method: "POST", headers: { Authorization: "Bearer root" },
    body: JSON.stringify({ name: "client", scopes }),
  }), env, ctx);
  const token = (await created.json()).token;
  const request = (path, method = "GET", body, credential = token) => worker.fetch(
    new Request(`https://hub.test${path}`, { method, body, headers: {
      Authorization: `Bearer ${credential}`, "Content-Type": "image/png",
    } }), env, ctx);
  return { request, objects };
}

test("scoped client stores and reads exact binary bytes, metadata and missing objects", async () => {
  const { request, objects } = await setup("files:read:photos/people/,files:write:photos/people/");
  const path = "/v1/files/photos/people/p1/a%20b.png";
  const bytes = new Uint8Array([0, 255, 32, 4]);
  expect((await request(path, "PUT", bytes)).status).toBe(201);
  expect(objects.has("photos/people/p1/a b.png")).toBe(true);
  const read = await request(path);
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
  expect(read.headers.get("Content-Type")).toBe("image/png");
  const head = await request(path, "HEAD");
  expect(head.headers.get("Content-Length")).toBe("4");
  expect(head.headers.get("Cache-Control")).toContain("no-transform");
  expect(await head.text()).toBe("");
  expect((await request("/v1/files/photos/people/missing")).status).toBe(404);
});

test("prefix scopes cannot cross namespaces or bypass via legacy archive routes", async () => {
  const { request, objects } = await setup("tables:read,files:read:photos/people/,files:write:photos/people/");
  for (const method of ["PUT", "GET", "HEAD", "DELETE", "POST"]) {
    for (const path of ["/v1/files/photos/records/a", "/v1/files/photos/people-other/a", "/v1/files/backups/a", "/v1/archive/backups/a", "/v1/archive/query"]) {
      expect((await request(path, method, ["PUT", "POST"].includes(method) ? "x" : undefined)).status).toBe(403);
    }
  }
  expect(objects.size).toBe(0);
  expect(allowed("/v1/rows/pull", "POST", ["tables:read"])).toBe(true);
  expect(allowed("/v1/rows/push", "POST", ["tables:write"])).toBe(true);
});

test("read and write grants are independent, revocable and never imply admin", async () => {
  const { request, objects } = await setup("files:write:photos/people/");
  expect((await request("/v1/files/photos/people/a", "PUT", "x")).status).toBe(201);
  for (const method of ["GET", "HEAD"]) {
    expect((await request("/v1/files/photos/people/a", method)).status).toBe(403);
    expect((await request("/v1/archive/photos/people/a", method)).status).toBe(403);
  }
  expect((await request("/v1/tokens/list", "POST", "{}")).status).toBe(403);
  expect((await request("/v1/tokens/revoke", "POST", '{"name":"client"}', "root")).status).toBe(200);
  expect((await request("/v1/files/photos/people/b", "PUT", "x")).status).toBe(403);
  expect(objects.size).toBe(1);
});

test("malformed, encoded separators and double-encoded keys fail before storage", async () => {
  const { request, objects } = await setup("files:write:photos/people/");
  for (const key of ["photos/people/%2e%2e%2fsecret", "photos%2Fpeople/a", "photos/people/%252e%252e/secret", "photos/people/%252Fsecret", "photos/people/%5Csecret", "photos/people/%00x", "photos/people//a", "photos/people/%ZZ"]) {
    const response = await request(`/v1/files/${key}`, "PUT", "x");
    expect([400, 403]).toContain(response.status);
  }
  expect(objects.size).toBe(0);
});

test("read only cannot write, malformed scope grants nothing, full retains archive access", () => {
  expect(allowed("/v1/files/photos/people/a", "PUT", ["files:read:photos/people/"])).toBe(false);
  expect(allowed("/v1/files/photos/people/a", "PUT", ["files:write:photos/people"])).toBe(false);
  expect(allowed("/v1/archive/backups/a", "GET", ["full"])).toBe(true);
  expect(allowed("/v1/archive/backups/a", "GET", ["tables:read"])).toBe(false);
});
