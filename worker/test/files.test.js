import { expect, test } from "bun:test";
import worker, { allowed } from "../src/index.js";
import contract from "../../tests/fixtures/hub-files-contract.json";
import { D1Shim } from "./d1shim.js";

async function setup(scopes) {
  const objects = new Map();
  const archive = {
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      if(options.sha256 && hex(options.sha256)!==hex(digest)) throw new Error('put: checksum mismatch (10037)');
      objects.set(key, { bytes, type: options.httpMetadata.contentType, digest:options.sha256?digest:undefined });
      return this.get(key);
    },
    async get(key) {
      const obj = objects.get(key);
      return obj && { body: obj.bytes, size: obj.bytes.length, httpEtag:'"etag-not-a-sha256"', checksums:{sha256:obj.digest}, httpMetadata:{contentType:obj.type},
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
  const request = (path, method = "GET", body, credential = token, headers = {}) => worker.fetch(
    new Request(`https://hub.test${path}`, { method, body, headers: {
      Authorization: `Bearer ${credential}`, "Content-Type": "image/png", ...headers,
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


const hex = buffer => [...new Uint8Array(buffer)].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest = async text => hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
const immutable = async text => ({'If-None-Match':'*','X-Content-SHA256':await digest(text),'Content-Type':'text/html'});

test('conditional creation verifies bytes and retries preserve the original artifact',async()=>{
  const {request}=await setup('files:read:captures/,files:write:captures/');
  const path='/v1/files/captures/attempt/page.html',body='<h1>Original</h1>',headers=await immutable(body);
  const first=await request(path,'PUT',body,undefined,headers);
  expect(first.status).toBe(201);
  expect(await first.json()).toEqual({...contract.conditional_put.body,etag:'"etag-not-a-sha256"'});
  for(const changed of [body,'<script>different()</script>']) {
    const response=await request(path,'PUT',changed,undefined,await immutable(changed));
    expect(response.status).toBe(412);expect(await response.json()).toEqual({error:'file_exists'});
    expect(await (await request(path)).text()).toBe(body);
  }
  for(const method of ['GET','HEAD']) {
    const read=await request(path,method);
    expect(read.headers.get('X-Content-SHA256')).toBe(await digest(body));
    expect(read.headers.get('Content-Length')).toBe(String(body.length));
  }
});

test('wrong or missing digests and unsupported conditions cannot create an object',async()=>{
  const {request,objects}=await setup('files:write:captures/');
  const path='/v1/files/captures/bad';
  const invalid=await request(path,'PUT','different',undefined,await immutable('expected'));
  expect(invalid.status).toBe(400);expect(await invalid.json()).toEqual({error:'checksum_mismatch'});
  for(const headers of [{'If-None-Match':'*'},{'If-Match':'*'},{'If-None-Match':'"etag"'},{'X-Content-SHA256':'bad'}]) {
    expect((await request(path,'PUT','body',undefined,headers)).status).toBe(400);
  }
  expect(objects.size).toBe(0);
});

test('all retrieved content is attachment, sandboxed and nosniff even with a misleading MIME or extension',async()=>{
  const {request}=await setup('files:read:captures/,files:write:captures/');
  for(const mime of ['text/html','text/html; charset=UTF-8','application/xhtml+xml','image/svg+xml','image/png','text/plain']) {
    const path='/v1/files/captures/disguised.png';
    expect((await request(path,'PUT','<script>fetch("/v1/session")</script>',undefined,{'Content-Type':mime})).status).toBe(201);
    for(const route of [path,path.replace('/files/','/archive/')]) for(const method of ['GET','HEAD']) {
      const response=await request(route,method);
      expect(response.headers.get('Content-Disposition')).toBe('attachment');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Security-Policy')).toBe(contract.retrieval_headers['Content-Security-Policy']);
    }
  }
});

test('capture metadata grants alone confer no file access and legacy writes still replace',async()=>{
  const narrow=await setup('tables:read:captures,tables:write:captures');
  for(const method of ['GET','HEAD','PUT']) expect((await narrow.request('/v1/files/captures/a',method,method==='PUT'?'x':undefined)).status).toBe(403);
  const legacy=await setup('files:read:captures/,files:write:captures/');
  await legacy.request('/v1/files/captures/a','PUT','first');
  expect((await legacy.request('/v1/files/captures/a','PUT','second')).status).toBe(201);
  const head=await legacy.request('/v1/files/captures/a','HEAD');
  expect(head.headers.get('X-Content-SHA256')).toBeNull();
  expect(await (await legacy.request('/v1/files/captures/a')).text()).toBe('second');
});
