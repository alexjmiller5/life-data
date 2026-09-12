import {
  deviceName,
  ensureAuthReady,
  validFingerprint,
  validLabel,
} from "./auth.js";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function page(title, content, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#1f2937}
main{border:1px solid #d1d5db;border-radius:12px;padding:2rem} h1{font-size:1.4rem}
code{overflow-wrap:anywhere} button{font:inherit;padding:.6rem 1rem;border-radius:8px;border:1px solid #6b7280;background:#111827;color:white;cursor:pointer}
label{display:block;margin:.8rem 0 .25rem} table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.5rem;border-bottom:1px solid #e5e7eb}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`,
    {
      status,
      headers: HTML_HEADERS,
    },
  );
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function accessIdentity(ctx, env) {
  if (
    !env.LOGIN_ACCESS_AUD ||
    !ctx?.access ||
    ctx.access.aud !== env.LOGIN_ACCESS_AUD ||
    typeof ctx.access.getIdentity !== "function"
  )
    return null;
  try {
    const identity = await ctx.access.getIdentity();
    const email =
      typeof identity?.email === "string" ? identity.email.trim() : "";
    return email ? { email } : null;
  } catch {
    return null;
  }
}

function sameOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

function queryValues(url) {
  const values = Object.fromEntries(url.searchParams.entries());
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("key") || !keys.includes("name"))
    return null;
  return values;
}

function parseForm(text, fields) {
  if (text.length > 4096) return null;
  const params = new URLSearchParams(text);
  const pairs = [...params.entries()];
  if (
    pairs.length !== fields.length ||
    pairs.some(([key]) => !fields.includes(key)) ||
    new Set(pairs.map(([key]) => key)).size !== fields.length
  )
    return null;
  return Object.fromEntries(pairs);
}

async function readForm(request, fields) {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    .trim();
  if (contentType !== "application/x-www-form-urlencoded") return null;
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 4096) return null;
  return parseForm(await request.text(), fields);
}

async function approvedLogin(request, env, url) {
  if (request.method !== "POST" || !sameOrigin(request, url)) {
    return json({ error: "same-origin form submission required" }, 403);
  }
  const form = await readForm(request, ["key", "name"]);
  if (!form || !validFingerprint(form.key) || !validLabel(form.name)) {
    return json({ error: "invalid login request" }, 400);
  }
  await ensureAuthReady(env.AUTH_DB);
  const name = deviceName(form.key);
  const existing = await env.AUTH_DB.prepare(
    "SELECT revoked_at FROM _tokens WHERE name = ?",
  )
    .bind(name)
    .first();
  if (existing?.revoked_at) {
    return page(
      "Life API token already revoked",
      "<p>This Life API token was revoked and cannot be reused.</p>",
      409,
    );
  }
  if (existing) {
    await env.AUTH_DB.prepare("UPDATE _tokens SET label = ? WHERE name = ?")
      .bind(form.name.trim(), name)
      .run();
  } else {
    await env.AUTH_DB.prepare(
      "INSERT INTO _tokens (hash, name, scopes, label) VALUES (?, ?, 'full', ?)",
    )
      .bind(form.key, name, form.name.trim())
      .run();
  }
  return page(
    "Life device approved",
    '<p>If the device is still waiting, it will finish signing in automatically. If you abandoned this request, revoke its API token in <a href="/login/devices">Life devices</a>.</p>',
  );
}

async function listDevices(env) {
  await ensureAuthReady(env.AUTH_DB);
  const { results } = await env.AUTH_DB.prepare(
    "SELECT name, label, created_at, last_used_at, revoked_at FROM _tokens WHERE name LIKE 'device:%' ORDER BY created_at",
  ).all();
  return results ?? [];
}

async function devicesPage(env) {
  const devices = await listDevices(env);
  const rows = devices
    .map(
      (device) =>
        `<tr><td>${escapeHtml(device.label || device.name)}<br>Approval code: <code>${escapeHtml(device.name.slice(7, 15))}</code></td><td>${escapeHtml(device.created_at || "")}</td><td>${device.revoked_at ? "Revoked" : "Active"}</td><td>${device.revoked_at ? "" : `<form method="post" action="/login/devices"><input type="hidden" name="name" value="${escapeHtml(device.name)}"><button type="submit">Revoke API token</button></form>`}</td></tr>`,
    )
    .join("");
  return page(
    "Life devices",
    `<p>Revoke a Life API token to stop that token accessing Life. Browser sessions are separate: a signed-in owner browser can approve devices.</p><table><thead><tr><th>Device</th><th>Created</th><th>Token status</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=4>No devices</td></tr>"}</tbody></table>`,
  );
}

async function revokeDevice(request, env, url) {
  if (request.method !== "POST" || !sameOrigin(request, url)) {
    return json({ error: "same-origin form submission required" }, 403);
  }
  const form = await readForm(request, ["name"]);
  if (!form || !/^device:[0-9a-f]{64}$/.test(form.name))
    return json({ error: "invalid device" }, 400);
  await ensureAuthReady(env.AUTH_DB);
  const result = await env.AUTH_DB.prepare(
    "UPDATE _tokens SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE name = ? AND name LIKE 'device:%' RETURNING name",
  )
    .bind(form.name)
    .first();
  if (!result) return json({ error: "device not found" }, 404);
  return page(
    "Life API token revoked",
    "<p>This token can no longer access Life. Browser sign-in is unchanged.</p>",
  );
}

export async function handleLogin(request, env, ctx, url) {
  const identity = await accessIdentity(ctx, env);
  if (!identity)
    return json({ error: "Cloudflare Access login required" }, 403);
  if (url.pathname === "/login" && request.method === "GET") {
    const values = queryValues(url);
    if (!values || !validFingerprint(values.key) || !validLabel(values.name)) {
      return json({ error: "invalid login link" }, 400);
    }
    return page(
      "Approve Life device",
      `<p><strong>${escapeHtml(identity.email)}</strong>, approve this device:</p><p><code>${escapeHtml(values.name)}</code></p><p>Approval code: <code>${escapeHtml(values.key.slice(0, 8))}</code></p><p>This approval link does not expire. Approve it only while your device is waiting to sign in.</p><form method="post" action="/login"><input type="hidden" name="key" value="${escapeHtml(values.key)}"><input type="hidden" name="name" value="${escapeHtml(values.name)}"><button type="submit">Approve device</button></form>`,
    );
  }
  if (url.pathname === "/login" && request.method === "POST")
    return approvedLogin(request, env, url);
  if (url.pathname === "/login/devices" && request.method === "GET")
    return devicesPage(env);
  if (url.pathname === "/login/devices" && request.method === "POST")
    return revokeDevice(request, env, url);
  return json({ error: "not found" }, 404);
}

export function loginPath(pathname) {
  return pathname === "/login" || pathname.startsWith("/login/");
}
