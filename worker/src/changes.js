// Instant sync. One ChangeSignal Durable Object per hub keeps a change
// sequence: every commit that changes replicated rows or schema bumps it. Open
// clients hold one hibernatable WebSocket and get `{seq, tables}` per burst of
// commits; older replicas long-poll GET /v1/changes. Either way a remote edit
// starts their sync round at once instead of on the next poll. The object keeps
// no per-client state and never retries: a dropped message is covered by the
// client's next round (every reconnect runs one).
import { AsyncLocalStorage } from "node:async_hooks";
import { deliverBackgroundPush, pushConfiguration } from "./apple-push.js";

export const MAX_WAIT = 25; // seconds a /v1/changes call may be held open
export const FLUSH_MS = 100; // one socket message per burst of commits
// Apple throttles apps sent more than a few background pushes an hour.
export const PUSH_GAP_MS = 20 * 60_000;
const PROTOCOL = "soma-changes-v1";
const TOKEN_PROTOCOL = "soma-token.";

const offered = (request) =>
  (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
const isUpgrade = (request) => request.headers.get("Upgrade")?.toLowerCase() === "websocket";

// A browser cannot set headers on a WebSocket, so it offers its device token as
// a second subprotocol beside PROTOCOL. Only PROTOCOL is ever echoed back.
export function socketToken(request) {
  if (!isUpgrade(request)) return "";
  const protocols = offered(request);
  if (!protocols.includes(PROTOCOL)) return "";
  return protocols.find((p) => p.startsWith(TOKEN_PROTOCOL))?.slice(TOKEN_PROTOCOL.length) ?? "";
}

export class ChangeSignal {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.waiters = new Set();
    this.pending = null; // tables changed since the last socket message
    this.deliver = deliverBackgroundPush;
    // Clients ping to notice a dead connection; the runtime answers without
    // waking a hibernated object.
    state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
    state.blockConcurrencyWhile(async () => {
      this.seq = (await state.storage.get("seq")) ?? 0;
    });
  }

  async fetch(request) {
    if (request.method === "POST") {
      const { tables } = await request.json().catch(() => ({}));
      this.seq += 1;
      await this.state.storage.put("seq", this.seq);
      for (const wake of [...this.waiters]) wake();
      if (!this.pending) {
        this.pending = new Set();
        setTimeout(() => this.flush(), FLUSH_MS);
      }
      for (const table of Array.isArray(tables) ? tables : []) if (typeof table === "string") this.pending.add(table);
      return Response.json({ seq: this.seq });
    }
    if (isUpgrade(request)) {
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      const headers = offered(request).includes(PROTOCOL) ? { "Sec-WebSocket-Protocol": PROTOCOL } : {};
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    const params = new URL(request.url).searchParams;
    const wait = Math.min(Number(params.get("wait")) || 0, MAX_WAIT);
    if (params.get("since") === String(this.seq) && wait > 0) {
      await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, wait * 1000);
        this.waiters.add(wake);
      });
    }
    return Response.json({ seq: this.seq });
  }

  flush() {
    const message = JSON.stringify({ seq: this.seq, tables: [...this.pending].sort() });
    this.pending = null;
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(message); } catch { /* a closing socket reconnects and runs a round */ }
    }
    if (pushConfiguration(this.env)) return this.backgroundPush();
  }

  // Closed and backgrounded native apps get a silent push instead: the first
  // change after a quiet gap sends one at once, later ones share one trailing
  // push when the gap ends.
  async backgroundPush() {
    try {
      const next = (await this.state.storage.get("nextPush")) ?? 0;
      if (Date.now() < next) {
        if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(next);
        return;
      }
      await this.alarm();
    } catch (e) {
      console.log(JSON.stringify({ background_push_error: String(e) }));
    }
  }

  async alarm() {
    await this.state.storage.put("nextPush", Date.now() + PUSH_GAP_MS);
    await this.deliver(this.env);
  }

  webSocketMessage() {} // clients only ping, and the auto-response answers that

  webSocketClose(ws, code) {
    try { ws.close(code, "closing"); } catch { /* already closed, or a reserved code */ }
  }
}

const stub = (env) => env.CHANGES.get(env.CHANGES.idFromName("hub"));

// GET /v1/changes with `Upgrade: websocket` opens the wake socket. Otherwise
// GET /v1/changes?since=<seq>&wait=<seconds>: `{seq}` at once when it differs
// from `since` (or none was given), otherwise when it moves or `wait` runs out.
export async function changesRoute(env, url, request) {
  if (!env.CHANGES) return Response.json({ error: "change signal unavailable" }, { status: 501 });
  if (request && isUpgrade(request)) return stub(env).fetch(request);
  const since = url.searchParams.get("since"), wait = url.searchParams.get("wait") ?? "0";
  if ((since !== null && !/^\d+$/.test(since)) || !/^\d+$/.test(wait)) {
    return Response.json({ error: "since and wait must be non-negative integers" }, { status: 400 });
  }
  const query = new URLSearchParams({ wait: String(Math.min(Number(wait), MAX_WAIT)) });
  if (since !== null) query.set("since", since);
  const response = await stub(env).fetch(`https://change-signal/?${query}`);
  return Response.json(await response.json(), { status: response.status });
}

// Writers call markChanged(tables) after a commit; the request or cron that
// runs them is wrapped once, so no writer needs env or ctx threaded through it.
const scope = new AsyncLocalStorage();

export function withChangeSignal(env, ctx, fn) {
  return scope.run({ env, ctx }, fn);
}

export function markChanged(tables = []) {
  const current = scope.getStore();
  if (!current?.env?.CHANGES) return;
  // A failed bump must never fail the write that caused it.
  const bump = stub(current.env)
    .fetch("https://change-signal/", { method: "POST", body: JSON.stringify({ tables: [...new Set(tables)] }) })
    .then((r) => r.body?.cancel())
    .catch((e) => console.log(JSON.stringify({ change_signal_error: String(e) })));
  current.ctx?.waitUntil?.(bump);
}
