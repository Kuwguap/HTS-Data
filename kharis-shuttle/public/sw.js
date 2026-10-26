/* Kharis Shuttle service worker.
 *
 * Hand-written, ES2019, no modules. Rules:
 *  - HTML, RSC payloads and API calls are NEVER cached (network only); a failed
 *    navigation falls back to the precached /offline page.
 *  - Cache-first only for hashed Next assets (/_next/static/*), app icons
 *    (/icons/*) and Carto basemap tiles (bounded to TILE_LIMIT entries).
 *  - Push payload / click handling mirrors src/lib/push/sw-logic.ts. Keep both
 *    in sync; that file is the unit-tested one.
 *
 * Bump VERSION on every deploy that should drop old caches.
 */
/* eslint-disable */
const VERSION = "2026-10-26.2";
const STATIC_CACHE = "ks-static-" + VERSION;
const TILE_CACHE = "ks-tiles-" + VERSION;
const CACHE_PREFIX = "ks-";
const OFFLINE_URL = "/offline";
const TILE_LIMIT = 300;

const DEFAULT_TITLE = "Kharis Shuttle";
const DEFAULT_URL = "/app";
const ICON_URL = "/icons/app/icon-192.png";
const BADGE_URL = "/icons/app/badge-72.png";
const RENOTIFY_KINDS = ["pickup_request_new"];

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
  if (tag) options.tag = tag;
  if (payload.kind && RENOTIFY_KINDS.indexOf(payload.kind) !== -1) options.renotify = true;
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
  if (/(^|\.)basemaps\.cartocdn\.com$/.test(u.hostname)) return "tile";
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
            .filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== STATIC_CACHE && k !== TILE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "SKIP_WAITING") self.skipWaiting();
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
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      let target = null;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.url && c.url.indexOf(origin) === 0) {
          if (c.url === url) {
            target = c;
            break;
          }
          if (!target) target = c;
        }
      }
      if (target) {
        const nav = target.url === url || typeof target.navigate !== "function" ? Promise.resolve(target) : target.navigate(url);
        return nav
          .catch(() => target)
          .then((win) => (win && typeof win.focus === "function" ? win.focus() : undefined));
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  const key = old && old.options ? old.options.applicationServerKey : null;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((sub) =>
        fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscriptionBody(sub.toJSON(), self.navigator.userAgent || "")),
        }),
      )
      .catch(() => undefined),
  );
});
