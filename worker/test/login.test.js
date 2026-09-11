import { expect, test } from "bun:test";
import worker, { ROUTES } from "../src/index.js";
import { hashToken } from "../src/auth.js";
import { D1Shim } from "./d1shim.js";

const ctx = {
  access: {
    aud: "login-aud",
    async getIdentity() {
      return { email: "alex@example.test" };
    },
  },
  waitUntil() {},
};

function environment() {
  return {
    HUB_TOKEN: "root",
    DB: new D1Shim(),
    AUTH_DB: new D1Shim(),
    LOGIN_ACCESS_AUD: "login-aud",
  };
}

function request(path, method = "GET", body, headers = {}) {
  return new Request(`https://hub.test${path}`, { method, body, headers });
}

test("login requires the platform Access context and ignores identity headers", async () => {
  const env = environment();
  const headers = { "Cf-Access-Authenticated-User-Email": "alex@example.test" };
  expect(
    (
      await worker.fetch(
        request(
          `/login?key=${"a".repeat(64)}&name=Mac`,
          "GET",
          undefined,
          headers,
        ),
        env,
        {},
      )
    ).status,
  ).toBe(403);
  const wrongAud = {
    access: {
      aud: "other",
      async getIdentity() {
        return { email: "alex@example.test" };
      },
    },
  };
  expect(
    (
      await worker.fetch(
        request(`/login?key=${"a".repeat(64)}&name=Mac`),
        env,
        wrongAud,
      )
    ).status,
  ).toBe(403);
});

test("approval page is non-mutating and escapes the label", async () => {
  const env = environment();
  const response = await worker.fetch(
    request(
      `/login?key=${"a".repeat(64)}&name=${encodeURIComponent("Mac <Air>")}`,
    ),
    env,
    ctx,
  );
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("Mac &lt;Air&gt;");
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "default-src 'none'",
  );
  expect(
    (
      await env.AUTH_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_tokens'",
      ).all()
    ).results,
  ).toEqual([]);
});

test("approval registers a full device token and session validates it", async () => {
  const env = environment();
  const token = "lt_" + "1".repeat(48);
  const fingerprint = await hashToken(token);
  const body = new URLSearchParams({
    key: fingerprint,
    name: "MacBook Air",
  }).toString();
  const response = await worker.fetch(
    request("/login", "POST", body, {
      Origin: "https://hub.test",
      "Content-Type": "application/x-www-form-urlencoded",
    }),
    env,
    ctx,
  );
  expect(response.status).toBe(200);
  const row = await env.AUTH_DB.prepare(
    "SELECT hash, name, scopes, label, revoked_at FROM _tokens",
  ).first();
  expect(row).toMatchObject({
    hash: fingerprint,
    name: `device:${fingerprint}`,
    scopes: "full",
    label: "MacBook Air",
    revoked_at: null,
  });
  const session = await worker.fetch(
    request("/v1/session", "GET", undefined, {
      Authorization: `Bearer ${token}`,
    }),
    env,
    { waitUntil() {} },
  );
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({
    name: `device:${fingerprint}`,
    scopes: ["full"],
  });
});

test("repeat approval is idempotent, while revoked keys cannot be reactivated", async () => {
  const env = environment();
  const fingerprint = "b".repeat(64);
  const approve = (name) =>
    worker.fetch(
      request(
        "/login",
        "POST",
        new URLSearchParams({ key: fingerprint, name }).toString(),
        {
          Origin: "https://hub.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      ),
      env,
      ctx,
    );
  expect((await approve("first")).status).toBe(200);
  expect((await approve("renamed")).status).toBe(200);
  expect(
    await env.AUTH_DB.prepare(
      "SELECT count(*) AS n, label FROM _tokens",
    ).first(),
  ).toEqual({ n: 1, label: "renamed" });
  const revoked = await worker.fetch(
    request(
      "/login/devices",
      "POST",
      new URLSearchParams({ name: `device:${fingerprint}` }).toString(),
      {
        Origin: "https://hub.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    ),
    env,
    ctx,
  );
  expect(revoked.status).toBe(200);
  expect((await approve("again")).status).toBe(409);
});

test("login forms require same-origin form encoding and reject unknown fields", async () => {
  const env = environment();
  const fingerprint = "c".repeat(64);
  const body = new URLSearchParams({
    key: fingerprint,
    name: "Mac",
    extra: "bad",
  }).toString();
  expect(
    (
      await worker.fetch(
        request("/login", "POST", body, {
          Origin: "https://evil.test",
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        env,
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await worker.fetch(
        request(
          "/login",
          "POST",
          JSON.stringify({ key: fingerprint, name: "Mac" }),
          {
            Origin: "https://hub.test",
            "Content-Type": "application/json",
          },
        ),
        env,
        ctx,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await env.AUTH_DB.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='_tokens'",
      ).first()
    ).n,
  ).toBe(0);
});

test("session logout revokes only the calling device and admin cannot self-revoke", async () => {
  const env = environment();
  const token = "lt_" + "2".repeat(48);
  const fingerprint = await hashToken(token);
  const body = new URLSearchParams({
    key: fingerprint,
    name: "Mac",
  }).toString();
  await worker.fetch(
    request("/login", "POST", body, {
      Origin: "https://hub.test",
      "Content-Type": "application/x-www-form-urlencoded",
    }),
    env,
    ctx,
  );
  const logout = await worker.fetch(
    request("/v1/session", "POST", "", { Authorization: `Bearer ${token}` }),
    env,
    { waitUntil() {} },
  );
  expect(logout.status).toBe(200);
  expect(
    (await worker.fetch(request("/v1/session"), env, { waitUntil() {} }))
      .status,
  ).toBe(401);
  const adminLogout = await worker.fetch(
    request("/v1/session", "POST", "", { Authorization: "Bearer root" }),
    env,
    { waitUntil() {} },
  );
  expect(adminLogout.status).toBe(403);
});

test("user schema writes cannot alter the separate auth registry", async () => {
  const env = environment();
  const token = "lt_" + "3".repeat(48);
  const fingerprint = await hashToken(token);
  const body = new URLSearchParams({
    key: fingerprint,
    name: "Mac",
  }).toString();
  await worker.fetch(
    request("/login", "POST", body, {
      Origin: "https://hub.test",
      "Content-Type": "application/x-www-form-urlencoded",
    }),
    env,
    ctx,
  );
  const schema = await worker.fetch(
    request(
      "/v1/schema/push",
      "POST",
      JSON.stringify({
        entries: [
          {
            applied_at: "2026-09-11T00:00:00.000Z",
            ddl: "CREATE TABLE _tokens (id TEXT PRIMARY KEY)",
          },
        ],
      }),
      {
        Authorization: "Bearer root",
        "Content-Type": "application/json",
      },
    ),
    env,
    { waitUntil() {} },
  );
  expect(schema.status).toBe(200);
  expect(
    (await worker.fetch(request("/v1/session"), env, { waitUntil() {} }))
      .status,
  ).toBe(401);
  const session = await worker.fetch(
    request("/v1/session", "GET", undefined, {
      Authorization: `Bearer ${token}`,
    }),
    env,
    { waitUntil() {} },
  );
  expect(session.status).toBe(200);
});
