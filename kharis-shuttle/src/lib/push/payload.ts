/**
 * What goes inside a web-push message. Mirrors `PushPayload` in lib/push/sw-logic.ts
 * (the service worker side) — keep the two in sync.
 */
import type { NotificationKind } from "@/lib/db.types";
import { publicEnv } from "@/lib/env";

export type PushPayload = {
  title: string;
  body: string;
  /** Same-origin path such as "/app/trips/123" — never an absolute URL. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
  kind: NotificationKind | string;
  /** notifications.id — lets the SW mark the inbox row read on click. */
  id: string;
  icon?: string;
  badge?: string;
};

/** Push services cap the encrypted message at 4 KB; keep our JSON well under it. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;

export const DEFAULT_URL = "/app";

/** The subset of a `notifications` / `claim_pending_notifications` row that the payload needs. */
export type NotificationLike = {
  id: string;
  kind: NotificationKind | string;
  title: string;
  body: string;
  url?: string | null;
  collapse_tag?: string | null;
  icon?: string | null;
  badge?: string | null;
};

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** UTF-8 size of the whole payload once serialised — what the push service sees. */
export function payloadBytes(payload: PushPayload): number {
  return byteLength(JSON.stringify(payload));
}

/** Bytes a string occupies inside the JSON (escapes included, quotes excluded). */
function escapedBytes(s: string): number {
  return byteLength(JSON.stringify(s)) - 2;
}

/**
 * Normalise a stored url to a same-origin path. Absolute URLs on our own origin
 * are reduced to their path; anything else (other origins, protocol-relative,
 * javascript:) falls back to /app so a push can never send someone off-site.
 */
export function toSameOriginPath(url: string | null | undefined): string {
  const raw = (url ?? "").trim();
  if (!raw) return DEFAULT_URL;
  if (raw.startsWith("/")) return raw.startsWith("//") ? DEFAULT_URL : raw;
  try {
    const parsed = new URL(raw);
    if (publicEnv.appUrl && parsed.origin === publicEnv.appUrl) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}` || DEFAULT_URL;
    }
  } catch {
    // not an absolute URL either
  }
  return DEFAULT_URL;
}

/**
 * Trim a string so that its JSON-escaped size (quotes, backslashes, newlines and
 * control characters all grow when serialised) fits in maxBytes, keeping an ellipsis.
 * Exported for tests.
 */
export function truncateEscaped(s: string, maxBytes: number): string {
  if (escapedBytes(s) <= maxBytes) return s;
  const ellipsis = "…";
  if (maxBytes < escapedBytes(ellipsis)) return "";
  const chars = Array.from(s);
  // Longest prefix whose escaped size plus the ellipsis fits (escaped size grows with the prefix).
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (escapedBytes(chars.slice(0, mid).join("") + ellipsis) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").trimEnd() + ellipsis;
}

/** Room left for `key` once every other field is serialised. */
function budgetFor(payload: PushPayload, key: "body" | "title" | "tag"): number {
  return Math.max(0, MAX_PAYLOAD_BYTES - payloadBytes({ ...payload, [key]: "" }));
}

/**
 * Build the payload for one outbox row. Never throws; always fits in
 * MAX_PAYLOAD_BYTES once serialised, measured on the escaped JSON (long bodies are
 * cut with an ellipsis, then the title, then optional media / url / tag as a last resort).
 */
export function buildPayload(row: NotificationLike): PushPayload {
  const payload: PushPayload = {
    title: (row.title || "").trim() || "Kharis Shuttle",
    body: (row.body || "").trim(),
    url: toSameOriginPath(row.url),
    tag: row.collapse_tag?.trim() || String(row.kind),
    kind: row.kind,
    id: row.id,
  };
  if (row.icon) payload.icon = row.icon;
  if (row.badge) payload.badge = row.badge;

  const fits = () => payloadBytes(payload) <= MAX_PAYLOAD_BYTES;
  const shrink: Array<() => void> = [
    () => {
      payload.body = truncateEscaped(payload.body, budgetFor(payload, "body"));
    },
    () => {
      // Pathological title (or icon URLs): drop optional media, cut the title too.
      delete payload.icon;
      delete payload.badge;
      payload.title = truncateEscaped(payload.title, budgetFor(payload, "title"));
    },
    () => {
      // Something other than text is huge (url / tag straight from the row): fall back to safe values.
      payload.url = DEFAULT_URL;
      payload.tag = truncateEscaped(payload.tag ?? String(payload.kind), budgetFor(payload, "tag"));
    },
  ];
  for (const step of shrink) {
    if (fits()) break;
    step();
  }
  return payload;
}

/** JSON string that is guaranteed to be <= MAX_PAYLOAD_BYTES. */
export function serializePayload(payload: PushPayload): string {
  const json = JSON.stringify(payload);
  if (byteLength(json) <= MAX_PAYLOAD_BYTES) return json;
  // Caller built the payload by hand; squeeze it through buildPayload's guard.
  return JSON.stringify(buildPayload({ ...payload, collapse_tag: payload.tag ?? null }));
}
