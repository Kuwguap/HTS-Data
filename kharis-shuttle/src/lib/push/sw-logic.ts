/**
 * Pure decision logic for the service worker (public/sw.js).
 *
 * sw.js cannot import modules (it must stay ES2019 and self-contained), so the
 * functions below are mirrored there verbatim. Keep both in sync: this file is
 * the one that gets unit-tested.
 */
import { APP_NAME } from "@/lib/constants";

export const DEFAULT_TITLE = APP_NAME;
export const DEFAULT_URL = "/app";
export const ICON_URL = "/icons/app/icon-192.png";
export const BADGE_URL = "/icons/app/badge-72.png";

/** Kinds whose notification should buzz again even when it replaces one with the same tag. */
export const RENOTIFY_KINDS = ["pickup_request_new"];

/** Message the page posts after registration so the worker can re-subscribe on its own. */
export const VAPID_KEY_MESSAGE = "VAPID_KEY";
/** Unversioned cache that survives activations; holds the VAPID key under META_VAPID_URL. */
export const META_CACHE = "ks-meta";
export const META_VAPID_URL = "/__ks-meta/vapid-key";

/** The JSON the server puts in a web-push message (see lib/push/payload.ts). */
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag?: string;
  kind?: string;
  id?: string;
  icon?: string;
  badge?: string;
};

/** What `notificationOptionsFor` returns: ready for `registration.showNotification(title, options)`. */
export type NotificationSpec = {
  title: string;
  options: {
    body: string;
    icon: string;
    badge: string;
    tag?: string;
    renotify?: boolean;
    data: { url: string; id: string | null; kind: string | null };
  };
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Parse the raw push message into a payload. Accepts the JSON text, an already
 * parsed object, or nothing at all (a push with no data still shows a generic
 * notification). Never throws.
 */
export function parsePushPayload(json: unknown): PushPayload {
  let raw: unknown = json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      // Plain-text push: use the text as the body.
      return { title: DEFAULT_TITLE, body: raw as string, url: DEFAULT_URL };
    }
  }
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    title: str(o.title) ?? DEFAULT_TITLE,
    body: str(o.body) ?? "",
    url: str(o.url) ?? DEFAULT_URL,
    tag: str(o.tag),
    kind: str(o.kind),
    id: str(o.id),
    icon: str(o.icon),
    badge: str(o.badge),
  };
}

/**
 * Build showNotification() arguments from a parsed payload. `renotify` is only
 * legal together with a `tag` (Chrome throws a TypeError otherwise).
 */
export function notificationOptionsFor(payload: PushPayload): NotificationSpec {
  const tag = payload.tag ?? (payload.kind && payload.id ? `${payload.kind}:${payload.id}` : undefined);
  const options: NotificationSpec["options"] = {
    body: payload.body,
    icon: payload.icon ?? ICON_URL,
    badge: payload.badge ?? BADGE_URL,
    data: { url: payload.url || DEFAULT_URL, id: payload.id ?? null, kind: payload.kind ?? null },
  };
  if (tag) {
    options.tag = tag;
    if (payload.kind && RENOTIFY_KINDS.indexOf(payload.kind) !== -1) options.renotify = true;
  }
  return { title: payload.title || DEFAULT_TITLE, options };
}

/**
 * Where a notification click should take the user. Takes the notification's
 * `data` (or the payload itself) and returns an absolute same-origin URL.
 * Anything that is not same-origin falls back to `/app`.
 */
export function resolveClickUrl(payload: { url?: string | null } | null | undefined, origin: string): string {
  const base = origin.replace(/\/$/, "");
  const url = payload && typeof payload.url === "string" ? payload.url.trim() : "";
  if (!url) return base + DEFAULT_URL;
  if (url.charAt(0) === "/") return url.charAt(1) === "/" ? base + DEFAULT_URL : base + url;
  try {
    const parsed = new URL(url);
    if (parsed.origin === base) return parsed.href;
  } catch {
    // not an absolute URL either
  }
  return base + DEFAULT_URL;
}

/**
 * Pick the window to reuse for a notification click: an exact URL match wins,
 * else the first same-origin window, else null (open a new one). The caller
 * must fall back to `clients.openWindow(url)` when `navigate()` rejects
 * (cross-document navigation of a client it does not control, iOS quirks).
 */
export function pickClickClient<T extends { url?: string }>(list: readonly T[], url: string, origin: string): T | null {
  const base = origin.replace(/\/$/, "");
  let target: T | null = null;
  for (const c of list) {
    if (!c.url || c.url.indexOf(base) !== 0) continue;
    if (c.url === url) return c;
    if (!target) target = c;
  }
  return target;
}

export type ResubscribePlan =
  | { action: "post"; subscription: { endpoint?: string; toJSON?: () => SubscriptionJson } }
  | { action: "subscribe"; key: ArrayBuffer | ArrayBufferView | string }
  | { action: "none"; reason: "no-key" };

/**
 * What to do on `pushsubscriptionchange`:
 * 1. the browser already made a new subscription → just POST it;
 * 2. else re-subscribe with the old subscription's key, or the key the page
 *    stored in the meta cache (the old subscription can be null on iOS);
 * 3. no key anywhere → nothing (the page re-subscribes on next launch).
 */
export function planResubscribe(
  event: {
    newSubscription?: { endpoint?: string; toJSON?: () => SubscriptionJson } | null;
    oldSubscription?: { options?: { applicationServerKey?: ArrayBuffer | ArrayBufferView | null } | null } | null;
  },
  storedKey: string | null | undefined,
): ResubscribePlan {
  if (event.newSubscription) return { action: "post", subscription: event.newSubscription };
  const oldKey = event.oldSubscription && event.oldSubscription.options ? event.oldSubscription.options.applicationServerKey : null;
  if (oldKey) return { action: "subscribe", key: oldKey };
  if (storedKey) return { action: "subscribe", key: storedKey };
  return { action: "none", reason: "no-key" };
}

/** VAPID public key (URL-safe base64) → the `applicationServerKey` bytes. Also in lib/push/client.ts. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type RequestClass = "static" | "tile" | "navigate" | "passthrough";

/**
 * Which caching strategy a request gets:
 * - `static`: cache-first (hashed Next assets, app icons)
 * - `tile`: cache-first with a bounded cache (Carto basemap tiles)
 * - `navigate`: network-only with the /offline fallback
 * - `passthrough`: untouched (API, RSC, everything else)
 */
export function classifyRequest(url: string, mode: string, origin: string, method = "GET"): RequestClass {
  if (method !== "GET") return "passthrough";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "passthrough";
  }
  const sameOrigin = u.origin === origin.replace(/\/$/, "");
  if (sameOrigin && (u.pathname.indexOf("/_next/static/") === 0 || u.pathname.indexOf("/icons/") === 0)) return "static";
  if (/(^|\.)basemaps\.cartocdn\.com$/.test(u.hostname)) return "tile";
  if (mode === "navigate") return "navigate";
  return "passthrough";
}

/** Platform guess for `push_subscriptions.platform`, from a user-agent string. */
export function platformFromUa(ua: string): "ios" | "android" | "desktop" | "other" {
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  if (/windows|macintosh|linux|cros/i.test(ua)) return "desktop";
  return "other";
}

export type SubscriptionJson = {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: { p256dh?: string; auth?: string };
};

/** Body for POST /api/push/subscribe from `PushSubscription.toJSON()`. */
export function subscriptionBody(
  sub: SubscriptionJson,
  ua: string,
): { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime: number | null; user_agent: string; platform: ReturnType<typeof platformFromUa> } {
  return {
    endpoint: sub.endpoint ?? "",
    keys: { p256dh: sub.keys?.p256dh ?? "", auth: sub.keys?.auth ?? "" },
    expirationTime: sub.expirationTime ?? null,
    user_agent: ua.slice(0, 512),
    platform: platformFromUa(ua),
  };
}
