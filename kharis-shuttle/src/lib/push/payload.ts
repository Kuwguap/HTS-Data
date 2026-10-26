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

/** Trim a string so that the whole payload fits, keeping an ellipsis. */
function truncate(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  const chars = Array.from(s);
  let out = "";
  for (const ch of chars) {
    if (byteLength(out + ch + "…") > maxBytes) break;
    out += ch;
  }
  return out.trimEnd() + "…";
}

/**
 * Build the payload for one outbox row. Never throws; always fits in
 * MAX_PAYLOAD_BYTES once serialised (long bodies are cut with an ellipsis,
 * then the title as a last resort).
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

  if (byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    const overheadWithoutBody = byteLength(JSON.stringify({ ...payload, body: "" }));
    const bodyBudget = Math.max(0, MAX_PAYLOAD_BYTES - overheadWithoutBody - 16);
    payload.body = truncate(payload.body, bodyBudget);
  }
  if (byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    // Pathological title (or icon URLs): cut the title too, drop optional media.
    delete payload.icon;
    delete payload.badge;
    const overheadWithoutTitle = byteLength(JSON.stringify({ ...payload, title: "" }));
    payload.title = truncate(payload.title, Math.max(0, MAX_PAYLOAD_BYTES - overheadWithoutTitle - 16));
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
