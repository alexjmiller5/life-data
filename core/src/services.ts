import type { Hub } from "./driver.ts";
import { validEditTimestamp, type Row } from "./validate.ts";

/** Native hosts implement GET with the same credential/redirect rules as POST. */
export interface ServiceHub extends Hub {
  get(route: string): Promise<{ data: unknown; date?: string }>;
}

export interface UsageSummary {
  period: { start: string; end: string; anchor_day: number };
  measured_at: string | null;
  capped: { metric: string; used: number; cap: number; resets_at: string } | null;
  metrics: Record<string, {
    kind: "cumulative" | "gauge"; unit: string; used: number | null;
    allowance: number | null; cap: number | null; alert_at: number[]; measured_at: string | null;
  }>;
  by_principal: {
    id: string; label: string | null; kind: string;
    rows_read: number; rows_written: number; requests: number;
  }[];
}

export interface HubNotification {
  seq: number;
  id: string;
  created_at: string;
  producer: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  /** Producer-owned JSON; clients must tolerate unknown producers and types. */
  data: unknown;
  read_at: string | null;
}

/** A complete walk, including read notifications for shared read-state reconciliation. */
export interface NotificationFeed {
  notifications: HubNotification[];
  next_cursor: null;
  latest_cursor: number;
  unread_count: number;
}

const record = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const sequence = (v: unknown): v is number => amount(v) && Number.isSafeInteger(v);
const nullableAmount = (v: unknown) => v === null || amount(v);
const nullableTime = (v: unknown) => v === null || validEditTimestamp(v);

export async function readUsage(hub: ServiceHub): Promise<UsageSummary> {
  const { data: u } = await hub.get("/v1/usage");
  if (!record(u) || !record(u.period)
    || !validEditTimestamp(u.period.start) || !validEditTimestamp(u.period.end)
    || (u.period.start as string) >= (u.period.end as string)
    || !sequence(u.period.anchor_day) || u.period.anchor_day < 1 || u.period.anchor_day > 28
    || !nullableTime(u.measured_at)
    || !(u.capped === null || (record(u.capped) && text(u.capped.metric) && amount(u.capped.used)
      && amount(u.capped.cap) && validEditTimestamp(u.capped.resets_at)))
    || !record(u.metrics) || !Object.values(u.metrics).every(m => record(m)
      && (m.kind === "cumulative" || m.kind === "gauge") && text(m.unit)
      && nullableAmount(m.used) && nullableAmount(m.allowance) && nullableAmount(m.cap)
      && Array.isArray(m.alert_at) && m.alert_at.every(amount) && nullableTime(m.measured_at))
    || !Array.isArray(u.by_principal) || !u.by_principal.every(p => record(p)
      && text(p.id) && (p.label === null || typeof p.label === "string") && text(p.kind)
      && amount(p.rows_read) && amount(p.rows_written) && amount(p.requests))) {
    throw new Error("invalid hub usage response");
  }
  return u as unknown as UsageSummary;
}

function isNotification(n: unknown): n is HubNotification {
  return record(n) && sequence(n.seq) && n.seq > 0 && text(n.id)
    && validEditTimestamp(n.created_at) && nullableTime(n.read_at)
    && text(n.producer) && text(n.type) && text(n.severity)
    && typeof n.title === "string" && typeof n.body === "string" && n.data !== undefined;
}

/** Refetch from zero every time: read state can change on another client. A
 * failed/bounded walk never returns a partial feed or a presentation checkpoint. */
export async function readNotifications(hub: ServiceHub): Promise<NotificationFeed> {
  const notifications: HubNotification[] = [];
  const ids = new Set<string>();
  let after = 0;
  let latest = 0;
  // 200,000 rows at full pages; an unbounded producer must fail explicitly.
  for (let pages = 0; pages < 1000; pages++) {
    const { data: p } = await hub.get(`/v1/notifications?after=${after}&limit=200`);
    if (!record(p) || !Array.isArray(p.notifications) || p.notifications.length > 200
      || !sequence(p.latest_cursor) || p.latest_cursor < latest || !sequence(p.unread_count)
      || !(p.next_cursor === null || sequence(p.next_cursor))) {
      throw new Error("invalid hub notification feed");
    }
    for (const n of p.notifications) {
      if (!isNotification(n) || n.seq <= after || n.seq > p.latest_cursor || ids.has(n.id)) {
        throw new Error("invalid hub notification feed");
      }
      notifications.push(n);
      ids.add(n.id);
      after = n.seq;
    }
    if (p.next_cursor === null) {
      return { notifications, next_cursor: null, latest_cursor: p.latest_cursor, unread_count: p.unread_count };
    }
    if (p.notifications.length === 0 || p.next_cursor !== after || p.next_cursor >= p.latest_cursor) {
      throw new Error("invalid hub notification feed");
    }
    latest = p.latest_cursor;
  }
  throw new Error("hub notification page limit exceeded");
}

export async function markNotificationsRead(
  hub: Hub, selector: { ids?: readonly string[]; through?: number },
): Promise<{ unread_count: number }> {
  if (!record(selector) || !Object.keys(selector).every(k => k === "ids" || k === "through")
    || (selector.ids === undefined && selector.through === undefined)
    || !(selector.ids === undefined || Array.isArray(selector.ids) && selector.ids.every(text))
    || !(selector.through === undefined || sequence(selector.through))) {
    throw new Error("invalid notification read selector");
  }
  const body = { ...(selector.ids === undefined ? {} : { ids: selector.ids }),
    ...(selector.through === undefined ? {} : { through: selector.through }) };
  const { data } = await hub.post("/v1/notifications/read", body);
  if (!record(data) || !sequence(data.unread_count)) throw new Error("invalid hub notification read response");
  return { unread_count: data.unread_count };
}

/** Pure proposal. Hosts persist baseline per endpoint only after successful
 * presentation, and manage notification permissions, timers and storage. */
export function notificationPresentation(
  feed: NotificationFeed, previousBaseline: number | null,
): { notifications: HubNotification[]; baseline: number } {
  if (previousBaseline !== null && !sequence(previousBaseline)) throw new Error("invalid notification baseline");
  if (feed.next_cursor !== null) throw new Error("incomplete notification feed");
  if (previousBaseline === null) return { notifications: [], baseline: feed.latest_cursor };
  let baseline = previousBaseline;
  const notifications: HubNotification[] = [];
  const seen = new Set<string>();
  for (const n of feed.notifications) {
    baseline = Math.max(baseline, n.seq);
    if (!seen.has(n.id) && n.seq > previousBaseline && n.read_at === null) notifications.push(n);
    seen.add(n.id);
  }
  return { notifications, baseline };
}
