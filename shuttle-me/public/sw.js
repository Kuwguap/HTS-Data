/* Shuttle Me service worker.
 *
 * Hand-written, ES2019, no modules. Rules:
 *  - HTML, RSC payloads and API calls are NEVER cached (network only); a failed
 *    navigation falls back to the precached /offline page.
 *  - Cache-first only for hashed Next assets (/_next/static/*), app icons
 *    (/icons/*) and basemap tiles from basemaps.cartocdn.com (keyed CARTO) or
 *    server.arcgisonline.com (Esri fallback), bounded to TILE_LIMIT entries. Tile layers must be created with
 *    crossOrigin: true, otherwise their responses are opaque and skipped.
 *  - The unversioned META_CACHE holds the VAPID public key the page posts after
 *    registration ({type:"VAPID_KEY", key}), so pushsubscriptionchange can
 *    re-subscribe even when the old subscription is gone (iOS).
 *  - Push payload / click handling mirrors src/lib/push/sw-logic.ts. Keep both
 *    in sync; that file is the unit-tested one.
 *
 * Bump VERSION on every deploy that should drop old caches.
 */
/* eslint-disable */
const VERSION = "2026-10-27.2";
const STATIC_CACHE = "ks-static-" + VERSION;
const TILE_CACHE = "ks-tiles-" + VERSION;
const META_CACHE = "ks-meta";
const META_VAPID_URL = "/__ks-meta/vapid-key";
const CACHE_PREFIX = "ks-";
const OFFLINE_URL = "/offline";
const TILE_LIMIT = 300;

const DEFAULT_TITLE = "Shuttle Me";
const DEFAULT_URL = "/app";
const ICON_URL = "/icons/app/icon-192.png";
const BADGE_URL = "/icons/app/badge-72.png";
const RENOTIFY_KINDS = ["pickup_request_new"];
const VAPID_KEY_MESSAGE = "VAPID_KEY";

/* ---------- pure logic (mirrored from src/lib/push/sw-logic.ts) ---------- */

function str(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parsePushPayload(json) {
  let raw = json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { title: DEFAULT_TITLE, body: raw, url: DEFAULT_URL };
    }
  }
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    title: str(o.title) || DEFAULT_TITLE,
    body: str(o.body) || "",
    url: str(o.url) || DEFAULT_URL,
    tag: str(o.tag),
    kind: str(o.kind),
    id: str(o.id),
    icon: str(o.icon),
    badge: str(o.badge),
  };
}

function notificationOptionsFor(payload) {
  const tag = payload.tag || (payload.kind && payload.id ? payload.kind + ":" + payload.id : undefined);
  const options = {
    body: payload.body,
    icon: payload.icon || ICON_URL,
    badge: payload.badge || BADGE_URL,
    data: { url: payload.url || DEFAULT_URL, id: payload.id || null, kind: payload.kind || null },
  };
  if (tag) {
    options.tag = tag;
    // renotify is only legal together with a tag.
    if (payload.kind && RENOTIFY_KINDS.indexOf(payload.kind) !== -1) options.renotify = true;
  }
  return { title: payload.title || DEFAULT_TITLE, options: options };
}

function resolveClickUrl(payload, origin) {
  const base = origin.replace(/\/$/, "");
  const url = payload && typeof payload.url === "string" ? payload.url.trim() : "";
  if (!url) return base + DEFAULT_URL;
  if (url.charAt(0) === "/") return url.charAt(1) === "/" ? base + DEFAULT_URL : base + url;
  try {
    const parsed = new URL(url);
    if (parsed.origin === base) return parsed.href;
  } catch (e) {
    // not absolute either
  }
  return base + DEFAULT_URL;
}

function pickClickClient(list, url, origin) {
  const base = origin.replace(/\/$/, "");
  let target = null;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c.url || c.url.indexOf(base) !== 0) continue;
    if (c.url === url) return c;
    if (!target) target = c;
  }
  return target;
}

// Stored (current) key first: the old subscription may carry a rotated VAPID key.
function planResubscribe(event, storedKey) {
  if (event.newSubscription) return { action: "post", subscription: event.newSubscription };
  if (storedKey) return { action: "subscribe", key: storedKey };
  const oldKey = event.oldSubscription && event.oldSubscription.options ? event.oldSubscription.options.applicationServerKey : null;
  if (oldKey) return { action: "subscribe", key: oldKey };
  return { action: "none", reason: "no-key" };
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function classifyRequest(url, mode, origin, method) {
  if ((method || "GET") !== "GET") return "passthrough";
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return "passthrough";
  }
  const sameOrigin = u.origin === origin.replace(/\/$/, "");
  if (sameOrigin && (u.pathname.indexOf("/_next/static/") === 0 || u.pathname.indexOf("/icons/") === 0)) return "static";
  if (/(^|\.)(server\.arcgisonline\.com|basemaps\.cartocdn\.com)$/.test(u.hostname)) return "tile";
  if (mode === "navigate") return "navigate";
  return "passthrough";
}

function platformFromUa(ua) {
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  if (/windows|macintosh|linux|cros/i.test(ua)) return "desktop";
  return "other";
}

function subscriptionBody(sub, ua) {
  const keys = sub.keys || {};
  return {
    endpoint: sub.endpoint || "",
    keys: { p256dh: keys.p256dh || "", auth: keys.auth || "" },
    expirationTime: sub.expirationTime == null ? null : sub.expirationTime,
    user_agent: ua.slice(0, 512),
    platform: platformFromUa(ua),
  };
}

/* ---------- meta cache (VAPID key) ---------- */

function storeVapidKey(key) {
  if (typeof key !== "string" || !key) return Promise.resolve();
  return caches
    .open(META_CACHE)
    .then((cache) => cache.put(META_VAPID_URL, new Response(key, { headers: { "Content-Type": "text/plain" } })))
    .catch(() => undefined);
}

function readVapidKey() {
  return caches
    .open(META_CACHE)
    .then((cache) => cache.match(META_VAPID_URL))
    .then((hit) => (hit ? hit.text() : null))
    .then((text) => (text && text.length > 0 ? text : null))
    .catch(() => null);
}

/* ---------- lifecycle ---------- */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== STATIC_CACHE && k !== TILE_CACHE && k !== META_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  else if (data.type === VAPID_KEY_MESSAGE) {
    const p = storeVapidKey(data.key);
    if (event.waitUntil) event.waitUntil(p);
  }
});

/* ---------- fetch ---------- */

function trimCache(cache, limit) {
  return cache.keys().then((keys) => {
    if (keys.length <= limit) return undefined;
    return Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
  });
}

function cacheFirst(cacheName, request, limit) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        // Only cache real 200s. Opaque (no-cors) responses are skipped: Chrome
        // pads them to ~7MB each in quota accounting.
        if (res && res.ok && res.type !== "opaque") {
          const copy = res.clone();
          cache
            .put(request, copy)
            .then(() => (limit ? trimCache(cache, limit) : undefined))
            .catch(() => undefined);
        }
        return res;
      });
    }),
  );
}

function offlineFallback() {
  return caches.match(OFFLINE_URL).then(
    (hit) =>
      hit ||
      new Response("<!doctype html><title>Offline</title><p>You're offline. Try again when you have signal.</p>", {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const kind = classifyRequest(request.url, request.mode, self.location.origin, request.method);
  if (kind === "static") {
    event.respondWith(cacheFirst(STATIC_CACHE, request, 0));
  } else if (kind === "tile") {
    event.respondWith(cacheFirst(TILE_CACHE, request, TILE_LIMIT));
  } else if (kind === "navigate") {
    event.respondWith(fetch(request).catch(() => offlineFallback()));
  }
  // passthrough: let the browser handle it (network only, nothing stored).
});

/* ---------- push ---------- */

self.addEventListener("push", (event) => {
  let text = null;
  try {
    text = event.data ? event.data.text() : null;
  } catch (e) {
    text = null;
  }
  const spec = notificationOptionsFor(parsePushPayload(text));
  event.waitUntil(self.registration.showNotification(spec.title, spec.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const origin = self.location.origin;
  const url = resolveClickUrl(event.notification.data, origin);
  const focus = (win) => (win && typeof win.focus === "function" ? win.focus() : win);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const target = pickClickClient(list, url, origin);
      if (!target) return self.clients.openWindow(url);
      if (target.url === url) return focus(target);
      if (typeof target.navigate !== "function") return self.clients.openWindow(url);
      // navigate() rejects for windows this worker does not control: open a fresh one
      // instead of focusing a stale page.
      return target
        .navigate(url)
        .then(focus)
        .catch(() => self.clients.openWindow(url));
    }),
  );
});

function postSubscription(sub) {
  return fetch("/api/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscriptionBody(sub.toJSON(), self.navigator.userAgent || "")),
  });
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    readVapidKey()
      .then((storedKey) => {
        const plan = planResubscribe(event, storedKey);
        if (plan.action === "post") return postSubscription(plan.subscription);
        if (plan.action === "subscribe") {
          const key = typeof plan.key === "string" ? urlBase64ToUint8Array(plan.key) : plan.key;
          return self.registration.pushManager
            .subscribe({ userVisibleOnly: true, applicationServerKey: key })
            .then((sub) => postSubscription(sub));
        }
        return undefined;
      })
      .catch(() => undefined),
  );
});
