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
      return obj && { key, uploaded: new Date("2026-01-01T00:00:00.000Z"), body: obj.bytes, size: obj.bytes.length, httpEtag:'"etag-not-a-sha256"', checksums:{sha256:obj.digest}, httpMetadata:{contentType:obj.type},
        writeHttpMetadata(headers) { headers.set("Content-Type", obj.type); } };
    },
    async head(key) { return this.get(key); },
    async delete(key) { objects.delete(key); },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
      const page = keys.slice(0, limit), truncated = keys.length > limit;
      return { objects: await Promise.all(page.map(k => this.get(k))), truncated, ...(truncated ? { cursor: page.at(-1) } : {}) };
    },
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
  return { request, objects, env };
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

const listed = objects => objects.map(o => ({...o, etag: '"etag-not-a-sha256"'}));

test('listing pages one prefix with opaque cursors and the canonical object shape',async()=>{
  const {request}=await setup('files:read:captures/,files:write:captures/');
  const body='<h1>Original</h1>';
  await request('/v1/files/captures/attempt/page.html','PUT',body,undefined,await immutable(body));
  const first=await request('/v1/files?prefix=captures/');
  expect(first.status).toBe(contract.listing.status);
  expect(first.headers.get('Cache-Control')).toBe('no-store');
  expect(await first.json()).toEqual({...contract.listing.body,objects:listed(contract.listing.body.objects)});
  for(const name of ['b','c','d']) await request(`/v1/files/captures/${name}`,'PUT','x');
  const seen=[];let cursor=null;
  do {
    const page=await (await request(`/v1/files?prefix=captures/&limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();
    expect(page.objects.length).toBeLessThanOrEqual(2);
    seen.push(...page.objects.map(o=>o.key));cursor=page.cursor;
  } while(cursor);
  expect(seen).toEqual(['captures/attempt/page.html','captures/b','captures/c','captures/d']);
});

test('a prefix reader lists only inside its grant while full and admin list everything',async()=>{
  const {request,objects}=await setup('files:read:photos/people/,files:write:photos/people/');
  await request('/v1/files/photos/people/a','PUT','x');
  objects.set('backups/daily/x.sql.gz',{bytes:new Uint8Array([1]),type:'application/gzip'});
  expect((await (await request('/v1/files?prefix=photos/people/p1/')).json()).objects).toEqual([]);
  for(const query of ['','?prefix=','?prefix=photos/','?prefix=photos/people','?prefix=backups/','?prefix=photos/records/'])
    expect((await request(`/v1/files${query}`)).status).toBe(403);
  const root=await (await request('/v1/files','GET',undefined,'root')).json();
  expect(root.objects.map(o=>o.key)).toEqual(['backups/daily/x.sql.gz','photos/people/a']);
  const full=await setup('full');
  await full.request('/v1/files/backups/a','PUT','x');
  expect((await (await full.request('/v1/files?prefix=backups/')).json()).objects.map(o=>o.key)).toEqual(['backups/a']);
});

test('write-only, table and malformed file grants cannot list',async()=>{
  for(const scopes of ['files:write:photos/people/','tables:read','files:read:photos/people','files:read:photos/../']) {
    const {request}=await setup(scopes);
    expect((await request('/v1/files?prefix=photos/people/')).status).toBe(403);
  }
});

test('listing rejects malformed parameters and methods before storage',async()=>{
  const {request}=await setup('files:read:captures/');
  for(const query of ['limit=0','limit=1001','limit=x','limit=1.5','limit=','prefix=captures/','other=1','cursor='])
    expect((await request(`/v1/files?prefix=captures/&${query}`)).status).toBe(400);
  expect((await request('/v1/files?prefix=captures/%01')).status).toBe(400);
  expect((await request('/v1/files?prefix=captures/','POST','x')).status).toBe(405);
});

const feed = async env => (await env.AUTH_DB.prepare("SELECT producer,type,severity,data FROM _notifications ORDER BY seq").all()).results
  .map(n=>({...n,data:JSON.parse(n.data)}));

test('full and admin delete one object and log it to the notification feed',async()=>{
  const {request,objects,env}=await setup('full');
  await request('/v1/files/raw/a%20b.json','PUT','four');
  await request('/v1/files/raw/keep.json','PUT','x');
  const deleted=await request('/v1/files/raw/a%20b.json','DELETE');
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({key:'raw/a b.json',bytes:4,etag:'"etag-not-a-sha256"'});
  expect([...objects.keys()]).toEqual(['raw/keep.json']);
  expect((await request('/v1/files/raw/keep.json','DELETE',undefined,'root')).status).toBe(200);
  expect(objects.size).toBe(0);
  expect(await feed(env)).toEqual([
    {producer:'files',type:'file.deleted',severity:'info',data:{key:'raw/a b.json',bytes:4,etag:'"etag-not-a-sha256"',by:'client'}},
    {producer:'files',type:'file.deleted',severity:'info',data:{key:'raw/keep.json',bytes:1,etag:'"etag-not-a-sha256"',by:'admin'}},
  ]);
});

test('consumer file and table grants can never delete',async()=>{
  const {request,objects}=await setup('files:read:raw/,files:write:raw/,tables:write');
  await request('/v1/files/raw/a','PUT','x');
  for(const path of ['/v1/files/raw/a','/v1/archive/raw/a']) expect((await request(path,'DELETE')).status).toBe(403);
  expect(objects.has('raw/a')).toBe(true);
});

test('catalog keys need the explicit catalog flag and other parameters are refused',async()=>{
  const {request,objects,env}=await setup('full');
  const key='__r2_data_catalog/ns/table/metadata/v1.json';
  await request(`/v1/files/${key}`,'PUT','x');
  for(const query of ['','?catalog=0','?catalog=','?catalog=true'])
    expect((await request(`/v1/files/${key}${query}`,'DELETE')).status).toBe(403);
  for(const query of ['?other=1','?catalog=1&catalog=1'])
    expect((await request(`/v1/files/raw/x${query}`,'DELETE')).status).toBe(400);
  expect(objects.has(key)).toBe(true);
  expect((await request(`/v1/files/${key}?catalog=1`,'DELETE')).status).toBe(200);
  expect(objects.has(key)).toBe(false);
  expect((await feed(env)).map(n=>n.data.key)).toEqual([key]);
});

test('a missing key, a malformed key or the legacy archive route deletes nothing and logs nothing',async()=>{
  const {request,objects,env}=await setup('full');
  await request('/v1/files/raw/a','PUT','x');
  expect((await request('/v1/files/raw/missing','DELETE')).status).toBe(404);
  expect((await request('/v1/files/raw%2Fa','DELETE')).status).toBe(400);
  expect((await request('/v1/archive/raw/a','DELETE')).status).toBe(404);
  expect(objects.has('raw/a')).toBe(true);
  expect(await feed(env)).toEqual([]);
});

const rehome = (request,body,credential) => request('/v1/files/rehome','POST',JSON.stringify(body),credential,{'Content-Type':'application/json'});

test('admin re-homes an unaddressable stored key to a canonical key and logs it',async()=>{
  const {request,objects,env}=await setup('full');
  const from='profiles/facebook/facebook_profile.php?id=1%2F2026-09-09T20%3A24%3A17.016Z.json';
  objects.set(from,{bytes:new TextEncoder().encode('{"a":1}'),type:'application/json'});
  const to='profiles/facebook/facebook_profile_1/2026-09-09T20-24-17.016Z.json';
  const moved=await rehome(request,{from,to},'root');
  expect(moved.status).toBe(200);
  expect(await moved.json()).toEqual({from,to,bytes:7,etag:'"etag-not-a-sha256"'});
  expect(objects.has(from)).toBe(false);
  const read=await request('/v1/files/profiles/facebook/facebook_profile_1/2026-09-09T20-24-17.016Z.json');
  expect(await read.text()).toBe('{"a":1}');
  expect(read.headers.get('Content-Type')).toBe('application/json');
  expect(await feed(env)).toEqual([{producer:'files',type:'file.rehomed',severity:'info',data:{from,to,bytes:7,etag:'"etag-not-a-sha256"',by:'admin'}}]);
});

test('only the admin token may re-home',async()=>{
  for(const scopes of ['full','files:read:profiles/,files:write:profiles/']) {
    const {request,objects}=await setup(scopes);
    objects.set('profiles/a%2Fb',{bytes:new Uint8Array([1]),type:'x/y'});
    expect((await rehome(request,{from:'profiles/a%2Fb',to:'profiles/a/b'})).status).toBe(403);
    expect([...objects.keys()]).toEqual(['profiles/a%2Fb']);
  }
});

test('re-home refuses bad targets, missing sources and overwrites',async()=>{
  const {request,objects,env}=await setup('full');
  objects.set('p/a%2Fb',{bytes:new Uint8Array([1]),type:'x/y'});
  objects.set('p/taken',{bytes:new Uint8Array([2]),type:'x/y'});
  for(const to of ['p/a%2Fb2','p//b','p/./b','p/../b','p\\b','p/\u0001',''])
    expect((await rehome(request,{from:'p/a%2Fb',to},'root')).status).toBe(400);
  for(const body of [{from:'p/a%2Fb'},{from:'p/a%2Fb',to:'p/c',extra:1},{from:'',to:'p/c'},[]])
    expect((await rehome(request,body,'root')).status).toBe(400);
  expect((await rehome(request,{from:'p/missing',to:'p/c'},'root')).status).toBe(404);
  expect((await rehome(request,{from:'p/a%2Fb',to:'p/taken'},'root')).status).toBe(412);
  expect(objects.get('p/taken').bytes).toEqual(new Uint8Array([2]));
  expect([...objects.keys()].sort()).toEqual(['p/a%2Fb','p/taken']);
  expect(await feed(env)).toEqual([]);
});

test('a copy that does not verify is removed and the original kept',async()=>{
  const {request,objects,env}=await setup('full');
  objects.set('p/a%2Fb',{bytes:new Uint8Array([1,2,3]),type:'x/y'});
  const put=env.ARCHIVE.put.bind(env.ARCHIVE);
  env.ARCHIVE.put=async(key,body,options)=>put(key,new Uint8Array([9]),options);
  expect((await rehome(request,{from:'p/a%2Fb',to:'p/a/b'},'root')).status).toBe(502);
  expect([...objects.keys()]).toEqual(['p/a%2Fb']);
  expect(await feed(env)).toEqual([]);
});
