import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import fixture from '../../tests/fixtures/enrollment-policy.json';
// @ts-ignore The real Worker and SQLite auth adapter are JavaScript.
import worker from '../../worker/src/index.js';
// @ts-ignore Existing test-only SQLite/D1 implementation.
import { D1Shim } from '../../worker/test/d1shim.js';
// @ts-ignore Match the existing Worker label contract, not a copied validator.
import { validLabel } from '../../worker/src/auth.js';

const fingerprint = 'a'.repeat(64);
const session = { name: `device:${fingerprint}`, scopes: ['full'] };
function handlers() {
  const unavailable = () => { throw new Error('pure enrollment must not use SQL or transport'); };
  return core.createCoreHandlers({ all: unavailable, run: unavailable, transaction: unavailable }, unavailable);
}

for (const entry of fixture.cases) {
  test(`canonical enrollment: ${entry.name}`, async () => {
    const run = (handlers() as any)[entry.operation];
    expect(typeof run).toBe('function');
    if ('error' in entry) {
      let failure: unknown;
      try { await run(entry.args); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(entry.error!);
    } else {
      expect(await run(entry.args)).toEqual(entry.want);
    }
  });
}

test('approval matches Worker trim, control and UTF16 length semantics', () => {
  for (const name of [' ', '\tExample', 'Example\n', 'Example\u007f', 'a'.repeat(100), 'a'.repeat(101), '🚀'.repeat(50), '🚀'.repeat(51), '\u00a0Example\ufeff', 'Example #?&=+/%']) {
    if (!validLabel(name)) {
      expect(() => core.enrollmentApproval({ fingerprint, name })).toThrow('invalid enrollment approval request');
      continue;
    }
    const result = core.enrollmentApproval({ fingerprint, name });
    const url = new URL(result.path, 'https://hub.example.test');
    expect([...url.searchParams.keys()]).toEqual(['key', 'name']);
    expect(url.searchParams.get('name')).toBe(name.trim());
    expect(url.searchParams.get('key')).toBe(fingerprint);
    expect(url.hash).toBe('');
  }
});

test('malformed UTF16 label has URLSearchParams replacement semantics', () => {
  const result = core.enrollmentApproval({ fingerprint, name: 'Example \ud800\udc00\ud800x\udc00' });
  expect(new URL(result.path, 'https://hub.example.test').searchParams.get('name')).toBe('Example 𐀀�x�');
});

test('session policy copies supported output and ignores unrelated future metadata', () => {
  const value = { ...session, scopes: ['full'], secret: 'private-response', capabilities: { row_api:'v1', files:'opaque-key-v1', subscriptions:null, schema: 'full-ddl-v1', replica_sync: true, unrelated: true } };
  const info = core.validateDeviceSession(value);
  value.scopes[0] = 'admin';
  expect(info).toEqual({ ...session, replica: { allowed: true, reason: null } });
  expect(JSON.stringify(info)).not.toContain('private-response');
});

test.each([null, [], {}, { name: 'x', scopes: null }, { name: 'x', scopes: [''] }, { name: 'x', scopes: [true] }].map(data => [data]))('malformed session fails safely %#', data => {
  expect(() => core.validateDeviceSession(data)).toThrow(/^invalid device session$/);
});

test.each([[], null, false, { schema: 1 }, { replica_sync: null }].map(caps => [caps]))('invalid advertised capability fields cannot grant replicas %#', capabilities => {
  expect(core.validateDeviceSession({ ...session, capabilities }).replica).toMatchObject({ allowed: false, reason: { code: 'invalid_capabilities' } });
});

test.each([undefined, null, [], {}, { status: '401', data: null }, { status: 401.5, data: null }, { status: 401 }, { status: 0, data: null }, { status: 401, data: null, retryAfterSeconds: -1 }, { status: 429, data: null, retryAfterSeconds: '10' }, { status: 503, data: null, retryAfterSeconds: Infinity }].map(reply => [reply]))('typed envelope rejects malformed status and retry metadata %#', reply => {
  expect(() => core.enrollmentPollResult(reply as any, fingerprint)).toThrow(/^invalid session reply$/);
  expect(() => core.sessionRevocationResult(reply as any)).toThrow(/^invalid session reply$/);
});

test('pending replies cannot smuggle approval and invalid fingerprints fail before classification', () => {
  expect(core.enrollmentPollResult({ status: 401, data: session }, fingerprint).state).toBe('pending');
  expect(() => core.enrollmentPollResult({ status: 401, data: null }, 'private-token')).toThrow(/^invalid enrollment fingerprint$/);
});

test('pure policies run in a JS realm without URL, fetch, crypto, clocks or storage', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'core-enrollment-'));
  try {
    const entry = join(temp, 'entry.ts');
    await writeFile(entry, `import * as Core from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).pathname)}; globalThis.Core = Core;`);
    const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
    expect(built.success).toBe(true);
    const realm = vm.createContext({ URL: undefined, URLSearchParams: undefined, fetch: undefined, crypto: undefined, Date: undefined, setTimeout: undefined });
    vm.runInContext(await built.outputs[0].text(), realm);
    const actual = vm.runInContext(`JSON.stringify(Core.enrollmentApproval(${JSON.stringify({ fingerprint, name: 'Example device' })}))`, realm);
    expect(JSON.parse(actual).path).toBe(`/login?key=${fingerprint}&name=Example%20device`);
    const poll = vm.runInContext(`JSON.stringify(Core.enrollmentPollResult(${JSON.stringify({ status: 200, data: session })}, ${JSON.stringify(fingerprint)}))`, realm);
    expect(JSON.parse(poll).session.replica.allowed).toBe(true);
    const all = vm.runInContext(`
      const unavailable = () => { throw new Error('unexpected host call'); };
      const handlers = Core.createCoreHandlers({ all: unavailable, run: unavailable, transaction: unavailable }, unavailable);
      JSON.stringify(${JSON.stringify(fixture.cases)}.map(entry => {
        try { return { want: handlers[entry.operation](entry.args) }; }
        catch (error) { return { error: error.message }; }
      }));
    `, realm);
    expect(JSON.parse(all)).toEqual(fixture.cases.map(entry => 'error' in entry ? { error: entry.error } : { want: entry.want }));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real Worker approval/session/logout match core and late approval remains possible after unauthorized cleanup', async () => {
  const env = { HUB_TOKEN: 'operator-fixture', DB: new D1Shim(), AUTH_DB: new D1Shim(), LOGIN_ACCESS_AUD: 'fixture-aud' };
  const ctx = { access: { aud: 'fixture-aud', async getIdentity() { return { email: 'owner@example.test' }; } }, waitUntil() {} };
  const token = `lt_${'1'.repeat(48)}`;
  const hash = new Bun.CryptoHasher('sha256').update(token).digest('hex');
  const call = async (path: string, method = 'GET', body?: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://hub.example.test${path}`, { method, body, headers }), env, ctx);
  const requestSession = async (method: string, credential = token) => {
    const response = await call('/v1/session', method, undefined, { Authorization: `Bearer ${credential}` });
    return { status: response.status, data: response.status === 200 ? await response.json() : null };
  };
  try {
    const approval = core.enrollmentApproval({ fingerprint: hash, name: '  Example device  ' });
    const page = await call(approval.path);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(token);
    expect(core.enrollmentPollResult(await requestSession('GET'), hash).state).toBe('pending');
    expect(core.sessionRevocationResult(await requestSession('POST'))).toEqual({ state: 'unauthorized' });
    // Closing the waiting client cannot invalidate an unregistered approval URL.
    const approved = await call('/login', 'POST', new URL(approval.path, 'https://hub.example.test').searchParams.toString(), {
      Origin: 'https://hub.example.test', 'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(approved.status).toBe(200);
    const reply = await requestSession('GET');
    expect(reply.data).toEqual({ name: `device:${hash}`, scopes: ['full'], capabilities: { row_api: 'v1', schema: 'full-ddl-v1', replica_sync: true, subscriptions: 'durable-pull-v1', conditional_patch: 'revision-v1', files: 'opaque-key-v1' } });
    expect(core.enrollmentPollResult(reply, hash)).toMatchObject({ state: 'approved', session: { replica: { allowed: true, reason: null } } });
    const admin = await requestSession('GET', 'operator-fixture');
    expect(() => core.validateDeviceSession(admin.data)).toThrow(/admin tokens/);
    expect(core.sessionRevocationResult(await requestSession('POST'))).toEqual({ state: 'revoked' });
    expect(core.enrollmentPollResult(await requestSession('GET'), hash).state).toBe('pending');
    const revokedApproval = await call('/login', 'POST', new URL(approval.path, 'https://hub.example.test').searchParams.toString(), {
      Origin: 'https://hub.example.test', 'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(revokedApproval.status).toBe(409);
  } finally { env.DB.db.close(); env.AUTH_DB.db.close(); }
});

test.each([{}, { unrelated: true }, { replica_sync: true }, { schema: 'full-ddl-v1' }, { replica_sync: true, schema: 'unknown-v2' }])('explicit incomplete/unsupported capabilities deny replicas %#', capabilities => {
  expect(core.validateDeviceSession({ ...session, capabilities }).replica.allowed).toBe(false);
});

test('explicit full replica contract permits enrollment while legacy absent capabilities remain valid', () => {
  expect(core.validateDeviceSession({ ...session, capabilities: { row_api:'v1', files:'opaque-key-v1', subscriptions:null, replica_sync: true, schema: 'full-ddl-v1' } }).replica.allowed).toBe(true);
  expect(core.validateDeviceSession(session).replica.allowed).toBe(true);
});

test.each([
  {row_api:'v999'}, {row_api:null}, {files:[]}, {subscriptions:123},
  {files:'unknown-v2'}, {subscriptions:'unknown-v2'},
])('explicit unknown or malformed protocol fields cannot enable replicas %#', change => {
  const capabilities={row_api:'v1',schema:'full-ddl-v1',replica_sync:true,files:'opaque-key-v1',subscriptions:'durable-pull-v1',...change};
  expect(core.validateDeviceSession({...session,capabilities}).replica.allowed).toBe(false);
});
