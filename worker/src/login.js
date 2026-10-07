import {
  deviceName,
  ensureAuthReady,
  validFingerprint,
  validLabel,
  authorityStatement,
} from "./auth.js";
import {enrollmentProfile} from './enrollment-profile.js';
import {pushConfiguration,ensurePush,pushEnrollmentStatement} from './apple-push.js';

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
  if (![2,3,4].includes(keys.length) || new Set(keys).size !== keys.length
    || !keys.includes("key") || !keys.includes("name") || keys.some(k=>!['key','name','profile','pushProfile'].includes(k)))
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
  // Read once, then require exactly one of the two supported forms.
  const contentType=request.headers.get('Content-Type')?.split(';',1)[0]?.trim();
  if (contentType !== 'application/x-www-form-urlencoded' || Number(request.headers.get('Content-Length')) > 4096) return json({error:'invalid login request'},400);
  const text=await request.text();
  const form = parseForm(text,["key","name"]) ?? parseForm(text,["key","name","profile","profileRevision"])
    ?? parseForm(text,["key","name","pushProfile"]) ?? parseForm(text,["key","name","profile","profileRevision","pushProfile"]);
  if (!form || !validFingerprint(form.key) || !validLabel(form.name)) {
    return json({ error: "invalid login request" }, 400);
  }
  const profile=Object.hasOwn(form,'profile') ? await enrollmentProfile(env,form.profile) : null;
  if (Object.hasOwn(form,'profile') && !profile) return json({error:'enrollment profile unavailable'},403);
  if (profile && form.profileRevision !== profile.revision) return json({error:'enrollment profile changed'},409);
  const push=Object.hasOwn(form,'pushProfile') ? pushConfiguration(env)?.profiles.find(p=>p.id===form.pushProfile) : null;
  if(Object.hasOwn(form,'pushProfile') && !push)return json({error:'push profile unavailable'},403);
  await ensureAuthReady(env.AUTH_DB);
  if(push)await ensurePush(env.AUTH_DB);
  const name = deviceName(form.key);
  const registration=env.AUTH_DB.prepare(`INSERT INTO _tokens
    (hash,name,scopes,label,enrollment_profile,enrollment_revision) VALUES (?,?,?,?,?,?)
    ON CONFLICT(hash) DO UPDATE SET label=${push?'_tokens.label':'excluded.label'}
    WHERE _tokens.name=excluded.name AND _tokens.revoked_at IS NULL
      AND _tokens.scopes=excluded.scopes AND _tokens.enrollment_profile IS excluded.enrollment_profile
      AND _tokens.enrollment_revision IS excluded.enrollment_revision
    RETURNING name`).bind(form.key,name,profile?profile.scopes.join(','):'full',form.name.trim(),profile?.id??null,profile?.revision??null);
  const statements=profile?[registration]:[registration,authorityStatement(env.AUTH_DB,form.key,'user',true)];
  if(push)statements.push(pushEnrollmentStatement(env.AUTH_DB,form.key,name,profile?profile.scopes.join(','):'full',
    push.id,profile?.id??null,profile?.revision??null));
  const result=await env.AUTH_DB.batch(statements);
  if (!result[0].results?.length) {
    return page(
      "Life API token cannot be reused",
      "<p>This token was revoked or belongs to a different approval. Start a new sign-in on the device.</p>",
      409,
    );
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
    const profile=Object.hasOwn(values,'profile') ? await enrollmentProfile(env,values.profile) : null;
    if (Object.hasOwn(values,'profile') && !profile) return json({error:'enrollment profile unavailable'},403);
    const push=Object.hasOwn(values,'pushProfile') ? pushConfiguration(env)?.profiles.find(p=>p.id===values.pushProfile) : null;
    if(Object.hasOwn(values,'pushProfile') && !push)return json({error:'push profile unavailable'},403);
    const profileFields=profile ? `<p>Application: <strong>${escapeHtml(profile.label)}</strong></p><p>${profile.scopes.some(s=>s.startsWith('tables:patch:'))?'Read and update access (listed fields only):':'Read-only access:'}</p><ul>${profile.scopes.map(s=>`<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul><input type="hidden" name="profile" value="${escapeHtml(profile.id)}"><input type="hidden" name="profileRevision" value="${profile.revision}">` : '';
    const pushFields=push ? `<p>Allow Apple push notifications for <strong>${escapeHtml(push.id)}</strong> (${escapeHtml(push.platform)}) on this installation.</p><input type="hidden" name="pushProfile" value="${escapeHtml(push.id)}">` : "";
    return page(
      "Approve Life device",
      `<p><strong>${escapeHtml(identity.email)}</strong>, approve this device:</p><p><code>${escapeHtml(values.name)}</code></p><p>Approval code: <code>${escapeHtml(values.key.slice(0, 8))}</code></p><p>This approval link does not expire. Approve it only while your device is waiting to sign in.</p><form method="post" action="/login"><input type="hidden" name="key" value="${escapeHtml(values.key)}"><input type="hidden" name="name" value="${escapeHtml(values.name)}">${profileFields}${pushFields}<button type="submit">Approve device</button></form>`,
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
