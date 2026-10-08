// Instant sync. One ChangeSignal Durable Object per hub keeps a change
// sequence: every commit that changes replicated rows or schema bumps it, and
// replicas long-poll GET /v1/changes so a remote edit starts their sync round
// at once instead of on the next poll. A missed bump only delays a replica
// until its slow safety round; nothing is ever read from the signal but "go".
import { AsyncLocalStorage } from "node:async_hooks";

export const MAX_WAIT = 25; // seconds a /v1/changes call may be held open

export class ChangeSignal {
  constructor(state) {
    this.state = state;
    this.waiters = new Set();
    state.blockConcurrencyWhile(async () => {
      this.seq = (await state.storage.get("seq")) ?? 0;
    });
  }

  async fetch(request) {
    if (request.method === "POST") {
      this.seq += 1;
      await this.state.storage.put("seq", this.seq);
      for (const wake of [...this.waiters]) wake();
      return Response.json({ seq: this.seq });
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
}

const stub = (env) => env.CHANGES.get(env.CHANGES.idFromName("hub"));

// GET /v1/changes?since=<seq>&wait=<seconds>: `{seq}` at once when it differs
// from `since` (or none was given), otherwise when it moves or `wait` runs out.
export async function changesRoute(env, url) {
  const since = url.searchParams.get("since"), wait = url.searchParams.get("wait") ?? "0";
  if ((since !== null && !/^\d+$/.test(since)) || !/^\d+$/.test(wait)) {
    return Response.json({ error: "since and wait must be non-negative integers" }, { status: 400 });
  }
  if (!env.CHANGES) return Response.json({ error: "change signal unavailable" }, { status: 501 });
  const query = new URLSearchParams({ wait: String(Math.min(Number(wait), MAX_WAIT)) });
  if (since !== null) query.set("since", since);
  const response = await stub(env).fetch(`https://change-signal/?${query}`);
  return Response.json(await response.json(), { status: response.status });
}

// Writers call markChanged() after a commit; the request or cron that runs
// them is wrapped once, so no writer needs env or ctx threaded through it.
const scope = new AsyncLocalStorage();

export function withChangeSignal(env, ctx, fn) {
  return scope.run({ env, ctx }, fn);
}

export function markChanged() {
  const current = scope.getStore();
  if (!current?.env?.CHANGES) return;
  // A failed bump must never fail the write that caused it.
  const bump = stub(current.env)
    .fetch("https://change-signal/", { method: "POST" })
    .then((r) => r.body?.cancel())
    .catch((e) => console.log(JSON.stringify({ change_signal_error: String(e) })));
  current.ctx?.waitUntil?.(bump);
}
