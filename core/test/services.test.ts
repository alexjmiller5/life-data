import { describe, expect, test } from "bun:test";
import fixture from "../../tests/fixtures/hub-usage-contract.json";
import * as core from "../src/index.ts";
import type { HubNotification, NotificationFeed, ServiceHub } from "../src/services.ts";

const { readUsage, readNotifications, markNotificationsRead, notificationPresentation } = core;
const stamp = fixture.usage.measured_at;
const notification = (seq: number, extra = {}): HubNotification => ({
  ...fixture.notifications.notifications[0], seq, id: `event:${seq}`, ...extra,
});
const page = <T extends number | null = null>(notifications: HubNotification[], next_cursor: T = null as T, latest_cursor = notifications.at(-1)?.seq ?? 0) => ({
  notifications, next_cursor, latest_cursor, unread_count: notifications.filter(n => n.read_at === null).length,
});
function hubReturning(data: unknown): ServiceHub {
  return { endpoint: "https://hub.example.test", async get() { return { data }; }, async post() { return { data }; } };
}

describe("usage service contract", () => {
  test("reads the canonical fixture, preserving null measurements and future metrics", async () => {
    const usage = structuredClone(fixture.usage);
    usage.by_principal[0].label = "Example device";
    const hub = hubReturning(usage);
    hub.get = async route => { expect(route).toBe("/v1/usage"); return { data: usage }; };
    expect<unknown>(await readUsage(hub)).toEqual(usage);
    const unmeasured = { ...usage, measured_at: null, capped: fixture.usage_capped.capped,
      metrics: { ...usage.metrics, future_metric: { ...usage.metrics.d1_storage_bytes, used: null, measured_at: null } } };
    const expected = structuredClone(unmeasured);
    const result = await readUsage(hubReturning(unmeasured));
    expect<unknown>(result).toEqual(expected);
    expect(result.metrics.future_metric.used).toBeNull();
  });

  test.each([
    null, [], {}, { ...fixture.usage, measured_at: "secret" },
    { ...fixture.usage, period: { ...fixture.usage.period, anchor_day: 29 } },
    { ...fixture.usage, period: { ...fixture.usage.period, end: fixture.usage.period.start } },
    { ...fixture.usage, capped: { ...fixture.usage_capped.capped, cap: "secret" } },
    { ...fixture.usage, by_principal: [{ ...fixture.usage.by_principal[0], requests: -1 }] },
    { ...fixture.usage, metrics: { x: { ...fixture.usage.metrics.requests, used: "secret" } } },
    { ...fixture.usage, metrics: { x: { ...fixture.usage.metrics.requests, used: Infinity } } },
    { ...fixture.usage, metrics: { x: { ...fixture.usage.metrics.requests, kind: "secret" } } },
    { ...fixture.usage, metrics: { x: { ...fixture.usage.metrics.requests, alert_at: [NaN] } } },
  ])("rejects malformed usage safely: %#", async data => {
    await expect(readUsage(hubReturning(data))).rejects.toThrow(/^invalid hub usage response$/);
  });
});

describe("notification feed", () => {
  test("reads the fixture and preserves unknown producers, types and data", async () => {
    expect(await readNotifications(hubReturning(fixture.notifications))).toEqual(fixture.notifications);
    const data = page([notification(9, { producer: "future", type: "future.event", data: { arbitrary: [1, null, true] } })]);
    expect(await readNotifications(hubReturning(data))).toEqual(data);
  });

  test("walks every ascending page and refetches from zero to reconcile shared read state", async () => {
    let read = false;
    const routes: string[] = [];
    const hub = hubReturning(null);
    hub.get = async route => {
      routes.push(route);
      return { data: route.includes("after=0&")
        ? { ...page([notification(2, { read_at: read ? stamp : null })], 2, 8), unread_count: read ? 1 : 2 }
        : { ...page([notification(8)], null, 8), unread_count: read ? 1 : 2 } };
    };
    expect(await readNotifications(hub)).toEqual({ ...page([notification(2), notification(8)]), unread_count: 2 });
    read = true;
    const feed = await readNotifications(hub);
    expect(feed.notifications[0].read_at).toBe(stamp);
    expect(feed.unread_count).toBe(1);
    expect(routes).toEqual(Array(2).fill(["/v1/notifications?after=0&limit=200", "/v1/notifications?after=2&limit=200"]).flat());
  });

  test("retains all rows when the latest cursor grows during the walk", async () => {
    const pages = [page([notification(1)], 1, 3), page([notification(3)], 3, 5), page([notification(5)])];
    const hub = hubReturning(null);
    hub.get = async () => ({ data: pages.shift() });
    expect((await readNotifications(hub)).notifications.map(n => n.seq)).toEqual([1, 3, 5]);
  });

  test.each([
    null, {}, { ...page([]), unread_count: -1 }, { ...page([]), latest_cursor: 1.5 },
    page([notification(0)]), page([notification(Number.MAX_SAFE_INTEGER + 1)]),
    page([notification(2), notification(1)], null, 2), page([notification(1), notification(1)]),
    page([notification(3)], null, 2), page([notification(1)], 0),
    page([notification(1)], 2, 3), page([], 1, 2),
    page([notification(1, { id: "" })]), page([notification(1, { read_at: "secret" })]),
    page([notification(1, { created_at: "secret" })]), page([notification(1, { producer: 1 })]),
    page([notification(1, { type: null })]), page([notification(1, { severity: false })]),
    page([notification(1, { title: null })]), page([notification(1, { body: {} })]),
    page([notification(1, { data: undefined })]),
    page(Array.from({ length: 201 }, (_, i) => notification(i + 1))),
  ])("rejects malformed or skipping feed pages safely: %#", async data => {
    let calls = 0;
    const hub = hubReturning(data);
    hub.get = async () => { calls++; return { data }; };
    await expect(readNotifications(hub)).rejects.toThrow(/^invalid hub notification feed$/);
    expect(calls).toBe(1);
  });

  test("rejects a repeated page instead of looping or silently skipping it", async () => {
    const hub = hubReturning(page([notification(1)], 1, 2));
    await expect(readNotifications(hub)).rejects.toThrow(/^invalid hub notification feed$/);
  });

  test.each([false, true])("rejects duplicate stable IDs before reaching keyed UI lists (across pages: %s)", async acrossPages => {
    const rows = [notification(1), notification(2, { id: "event:1" })];
    const pages = acrossPages ? [page([rows[0]], 1, 2), page([rows[1]])] : [page(rows)];
    const hub = hubReturning(null);
    hub.get = async () => ({ data: pages.shift() });
    await expect(readNotifications(hub)).rejects.toThrow(/^invalid hub notification feed$/);
  });

  test("rejects a regressing latest cursor during a walk", async () => {
    const pages = [page([notification(1)], 1, 3), page([notification(2)], null, 2)];
    const hub = hubReturning(null);
    hub.get = async () => ({ data: pages.shift() });
    await expect(readNotifications(hub)).rejects.toThrow(/^invalid hub notification feed$/);
  });

  test("page failures return no partial feed and retries start at zero", async () => {
    let fail = true;
    const routes: string[] = [];
    const hub = hubReturning(null);
    hub.get = async route => {
      routes.push(route);
      if (route.includes("after=0&")) return { data: page([notification(1)], 1, 2) };
      if (fail) throw new Error("hub HTTP 503");
      return { data: page([notification(2)]) };
    };
    await expect(readNotifications(hub)).rejects.toThrow("hub HTTP 503");
    fail = false;
    expect((await readNotifications(hub)).notifications.map(n => n.seq)).toEqual([1, 2]);
    expect(routes[2]).toBe("/v1/notifications?after=0&limit=200");
  });

  test("an endlessly growing feed fails explicitly at a finite page bound", async () => {
    let calls = 0;
    const hub = hubReturning(null);
    hub.get = async () => {
      if (++calls > 1000) throw new Error("test guard: unbounded pagination");
      return { data: page([notification(calls)], calls, calls + 1) };
    };
    await expect(readNotifications(hub)).rejects.toThrow(/^hub notification page limit exceeded$/);
    expect(calls).toBeLessThanOrEqual(1000);
  });
});

describe("mark notifications read", () => {
  test.each([{ ids: ["event:1", "event:2"] }, { through: 7 }, { ids: [] }, { through: 0 },
    { ids: ["event:9"], through: 7 }])("posts only the fixed endpoint and validated selector %j", async selector => {
    const hub = hubReturning(null);
    hub.post = async (route, body) => {
      expect(route).toBe("/v1/notifications/read"); expect(body).toEqual(selector);
      return { data: fixture.mark_read };
    };
    expect(await markNotificationsRead(hub, selector)).toEqual({ unread_count: 0 });
  });

  test.each([{}, null, { ids: "secret" }, { ids: [1] }, { ids: [""] }, { through: -1 },
    { through: 1.5 }, { through: Number.MAX_SAFE_INTEGER + 1 }, { ids: [1], through: 2 }, { ids: [], through: -1 },
    { ids: [], token: "secret" }])("rejects invalid selectors before sending: %#", async selector => {
    const hub = hubReturning(null);
    hub.post = async () => { throw new Error("must not send"); };
    await expect(markNotificationsRead(hub, selector as { ids?: string[]; through?: number }))
      .rejects.toThrow(/^invalid notification read selector$/);
  });

  test.each([null, {}, { unread_count: -1 }, { unread_count: "secret" }])("validates the read receipt: %#", async data => {
    await expect(markNotificationsRead(hubReturning(data), { through: 1 })).rejects.toThrow(/^invalid hub notification read response$/);
  });
});

describe("notification presentation checkpoints", () => {
  test("first contact suppresses history and baselines the overall latest cursor", () => {
    expect(notificationPresentation(page([notification(7)], null, 10), null))
      .toEqual({ notifications: [], baseline: 10 });
  });

  test("subsequent presentation advances through collected rows only, including shared reads", () => {
    const feed: NotificationFeed = { ...page([notification(3), notification(6), notification(8, { read_at: stamp })], null, 12), next_cursor: null };
    expect(notificationPresentation(feed, 4)).toEqual({ notifications: [notification(6)], baseline: 8 });
    expect(notificationPresentation(page([], null, 12), 4)).toEqual({ notifications: [], baseline: 4 });
    expect(notificationPresentation(page([notification(3)]), 9)).toEqual({ notifications: [], baseline: 9 });
  });

  test("deduplicates stable IDs across the full feed and does not mutate input", () => {
    const feed = { ...page([notification(1), notification(3, { id: "event:1" }), notification(4), notification(5, { id: "event:4" })]), next_cursor: null };
    const before = structuredClone(feed);
    const expected = { notifications: [notification(4)], baseline: 5 };
    expect(notificationPresentation(feed, 2)).toEqual(expected);
    expect(notificationPresentation(feed, 2)).toEqual(expected); // failed presentation can retry
    expect(notificationPresentation(feed, expected.baseline)).toEqual({ notifications: [], baseline: 5 });
    expect(feed).toEqual(before);
  });

  test.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid persisted baseline %s", baseline => {
    expect(() => notificationPresentation(page([]), baseline)).toThrow(/^invalid notification baseline$/);
  });

  test("refuses incomplete feeds without proposing a checkpoint", () => {
    expect(() => notificationPresentation(page([notification(1)], 1, 2) as unknown as NotificationFeed, 0))
      .toThrow(/^incomplete notification feed$/);
  });
});
