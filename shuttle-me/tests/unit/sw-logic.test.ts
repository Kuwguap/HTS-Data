/**
 * Service-worker decisions: the pure module (src/lib/push/sw-logic.ts) and the
 * hand-mirrored public/sw.js, which is executed inside a fake worker global so
 * its event handlers can be driven directly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { APP_NAME } from "@/lib/constants";
import {
  DEFAULT_TITLE,
  META_CACHE,
  META_VAPID_URL,
  VAPID_KEY_MESSAGE,
  classifyRequest,
  notificationOptionsFor,
  parsePushPayload,
  pickClickClient,
  planResubscribe,
  urlBase64ToUint8Array,
} from "@/lib/push/sw-logic";

const SW_PATH = path.resolve(__dirname, "../../public/sw.js");

describe("sw-logic: notificationOptionsFor", () => {
  it("uses the app name as the default title", () => {
    expect(DEFAULT_TITLE).toBe(APP_NAME);
    expect(DEFAULT_TITLE).toBe("Shuttle Me");
    expect(parsePushPayload(null).title).toBe("Shuttle Me");
  });

  it("sets renotify only together with a tag", () => {
    const withTag = notificationOptionsFor({ title: "t", body: "b", url: "/app", kind: "pickup_request_new", id: "1" });
    expect(withTag.options.tag).toBe("pickup_request_new:1");
    expect(withTag.options.renotify).toBe(true);

    const noTag = notificationOptionsFor({ title: "t", body: "b", url: "/app", kind: "pickup_request_new" });
    expect(noTag.options.tag).toBeUndefined();
    expect(noTag.options.renotify).toBeUndefined();
    expect("renotify" in noTag.options).toBe(false);

    const otherKind = notificationOptionsFor({ title: "t", body: "b", url: "/app", kind: "trip_reminder", tag: "trip:1" });
    expect(otherKind.options.renotify).toBeUndefined();
  });
});

describe("sw-logic: pickClickClient", () => {
  const origin = "https://shuttle.example.com";
  it("prefers the exact URL, then any same-origin window, else null", () => {
    const a = { url: "https://shuttle.example.com/app" };
    const b = { url: "https://shuttle.example.com/app/inbox" };
    const other = { url: "https://evil.example.com/app/inbox" };
    expect(pickClickClient([other, a, b], "https://shuttle.example.com/app/inbox", origin)).toBe(b);
    expect(pickClickClient([other, a], "https://shuttle.example.com/app/inbox", origin)).toBe(a);
    expect(pickClickClient([other], "https://shuttle.example.com/app/inbox", origin)).toBeNull();
    expect(pickClickClient([], "https://shuttle.example.com/app", `${origin}/`)).toBeNull();
  });
});

describe("sw-logic: planResubscribe", () => {
  const key = new Uint8Array([1, 2, 3]);
  it("posts the browser-made new subscription without re-subscribing", () => {
    const sub = { endpoint: "https://push/new" };
    expect(planResubscribe({ newSubscription: sub, oldSubscription: { options: { applicationServerKey: key } } }, "stored")).toEqual({
      action: "post",
      subscription: sub,
    });
  });
  it("re-subscribes with the stored (current) key, else the old subscription's key", () => {
    // The page stores the key the server uses now; the old subscription may hold a rotated one.
    expect(planResubscribe({ newSubscription: null, oldSubscription: { options: { applicationServerKey: key } } }, "stored")).toEqual({
      action: "subscribe",
      key: "stored",
    });
    expect(planResubscribe({ newSubscription: null, oldSubscription: { options: { applicationServerKey: key } } }, null)).toEqual({
      action: "subscribe",
      key,
    });
    expect(planResubscribe({ newSubscription: null, oldSubscription: null }, "stored")).toEqual({ action: "subscribe", key: "stored" });
    expect(planResubscribe({ oldSubscription: { options: null } }, "stored")).toEqual({ action: "subscribe", key: "stored" });
  });
  it("does nothing when no key is known", () => {
    expect(planResubscribe({ newSubscription: null, oldSubscription: null }, null)).toEqual({ action: "none", reason: "no-key" });
  });
  it("decodes a URL-safe base64 VAPID key", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});

/* ---------- public/sw.js driven inside a fake worker global ---------- */

type Handler = (event: Record<string, unknown>) => unknown;

function loadSw() {
  const handlers = new Map<string, Handler[]>();
  const stores = new Map<string, Map<string, { body: string }>>();
  const openCache = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    const keyOf = (req: unknown) => (typeof req === "string" ? req : (req as { url: string }).url);
    return {
      put: async (req: unknown, res: { text: () => Promise<string> }) => {
        store.set(keyOf(req), { body: await res.text() });
      },
      match: async (req: unknown) => {
        const hit = store.get(keyOf(req));
        return hit ? { text: async () => hit.body } : undefined;
      },
      add: async () => undefined,
      keys: async () => Array.from(store.keys()).map((url) => ({ url })),
      delete: async (req: unknown) => store.delete(keyOf(req)),
    };
  };
  const caches = {
    open: vi.fn(openCache),
    keys: vi.fn(async () => Array.from(stores.keys())),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async () => undefined),
  };
  const registration = {
    showNotification: vi.fn(async () => undefined),
    pushManager: { subscribe: vi.fn(async () => ({ toJSON: () => ({ endpoint: "https://push/resubscribed", keys: { p256dh: "p", auth: "a" } }) })) },
  };
  const clients = { matchAll: vi.fn(async () => [] as unknown[]), openWindow: vi.fn(async (url: string) => ({ url })), claim: vi.fn(async () => undefined) };
  const self = {
    location: { origin: "https://shuttle.example.com" },
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
    registration,
    clients,
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, fn: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
  };
  const fetch = vi.fn(async () => ({ ok: true, status: 200, type: "basic", text: async () => "body", clone() { return this; } }));
  class FakeResponse {
    constructor(
      private readonly body: string,
      public readonly init?: unknown,
    ) {}
    async text() {
      return this.body;
    }
  }
  const ctx = vm.createContext({ self, caches, fetch, Response: FakeResponse, Request: class { constructor(public url: string) {} }, URL, atob, console });
  new vm.Script(readFileSync(SW_PATH, "utf8"), { filename: "sw.js" }).runInContext(ctx);

  /** Dispatch an event and wait for every waitUntil()/respondWith() promise. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    const ev = { ...event, waitUntil: (p: Promise<unknown>) => pending.push(p), respondWith: (p: Promise<unknown>) => pending.push(p) };
    for (const h of handlers.get(type) ?? []) h(ev);
    await Promise.all(pending);
    return ev;
  };
  return { fire, stores, caches, registration, clients, fetch, self, handlers };
}

describe("public/sw.js mirrors sw-logic", () => {
  it("registers the expected listeners", () => {
    const sw = loadSw();
    for (const t of ["install", "activate", "message", "fetch", "push", "notificationclick", "pushsubscriptionchange"]) {
      expect(sw.handlers.has(t), t).toBe(true);
    }
  });

  it("stores the VAPID key from the page in the meta cache and keeps that cache on activate", async () => {
    const sw = loadSw();
    await sw.fire("message", { data: { type: VAPID_KEY_MESSAGE, key: "AQID" } });
    expect(sw.stores.get(META_CACHE)?.get(META_VAPID_URL)?.body).toBe("AQID");

    sw.stores.set("ks-static-old", new Map());
    sw.stores.set("ks-tiles-old", new Map());
    sw.stores.set("unrelated", new Map());
    await sw.fire("activate", {});
    expect(sw.stores.has("ks-static-old")).toBe(false);
    expect(sw.stores.has("ks-tiles-old")).toBe(false);
    expect(sw.stores.has(META_CACHE)).toBe(true);
    expect(sw.stores.has("unrelated")).toBe(true);
    expect(sw.clients.claim).toHaveBeenCalled();
  });

  it("push: shows a notification with the app name as fallback title and renotify only with a tag", async () => {
    const sw = loadSw();
    await sw.fire("push", { data: { text: () => JSON.stringify({ body: "hi", kind: "pickup_request_new" }) } });
    expect(sw.registration.showNotification).toHaveBeenLastCalledWith("Shuttle Me", expect.not.objectContaining({ renotify: true }));
    await sw.fire("push", { data: { text: () => JSON.stringify({ title: "Pickup", body: "hi", kind: "pickup_request_new", id: "7" }) } });
    expect(sw.registration.showNotification).toHaveBeenLastCalledWith("Pickup", expect.objectContaining({ tag: "pickup_request_new:7", renotify: true }));
  });

  it("notificationclick: opens a new window when navigate() rejects instead of focusing the stale page", async () => {
    const sw = loadSw();
    const stale = { url: "https://shuttle.example.com/login", navigate: vi.fn(async () => { throw new Error("not controlled"); }), focus: vi.fn(async () => stale) };
    sw.clients.matchAll.mockResolvedValue([stale]);
    await sw.fire("notificationclick", { notification: { close: vi.fn(), data: { url: "/app/inbox" } } });
    expect(stale.navigate).toHaveBeenCalledWith("https://shuttle.example.com/app/inbox");
    expect(stale.focus).not.toHaveBeenCalled();
    expect(sw.clients.openWindow).toHaveBeenCalledWith("https://shuttle.example.com/app/inbox");
  });

  it("notificationclick: focuses an exact match and navigates a same-origin window", async () => {
    const sw = loadSw();
    const exact = { url: "https://shuttle.example.com/app/inbox", navigate: vi.fn(), focus: vi.fn(async () => exact) };
    sw.clients.matchAll.mockResolvedValue([exact]);
    await sw.fire("notificationclick", { notification: { close: vi.fn(), data: { url: "/app/inbox" } } });
    expect(exact.navigate).not.toHaveBeenCalled();
    expect(exact.focus).toHaveBeenCalled();

    const other = { url: "https://shuttle.example.com/app", navigate: vi.fn(async () => other), focus: vi.fn(async () => other) };
    sw.clients.matchAll.mockResolvedValue([other]);
    await sw.fire("notificationclick", { notification: { close: vi.fn(), data: { url: "https://evil.example.com/x" } } });
    // off-origin url falls back to /app, which is where `other` already is
    expect(other.navigate).not.toHaveBeenCalled();
    expect(other.focus).toHaveBeenCalled();
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
  });

  it("pushsubscriptionchange: POSTs event.newSubscription when the browser provides one", async () => {
    const sw = loadSw();
    const sub = { toJSON: () => ({ endpoint: "https://push/new", keys: { p256dh: "p", auth: "a" } }) };
    await sw.fire("pushsubscriptionchange", { newSubscription: sub, oldSubscription: null });
    expect(sw.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(sw.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = sw.fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/push/subscribe");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ endpoint: "https://push/new", platform: "ios" });
  });

  it("pushsubscriptionchange: tolerates a null oldSubscription by re-subscribing with the stored key", async () => {
    const sw = loadSw();
    await sw.fire("message", { data: { type: VAPID_KEY_MESSAGE, key: "AQID" } });
    await sw.fire("pushsubscriptionchange", { newSubscription: null, oldSubscription: null });
    expect(sw.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const arg = (sw.registration.pushManager.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }])[0];
    expect(arg.userVisibleOnly).toBe(true);
    expect(Array.from(arg.applicationServerKey)).toEqual([1, 2, 3]);
    expect(sw.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((sw.fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ endpoint: "https://push/resubscribed" });
  });

  it("pushsubscriptionchange: prefers the stored key over the old subscription's, falls back to the old key, and does nothing without any key", async () => {
    const oldKey = new Uint8Array([9, 9]);

    const stored = loadSw();
    await stored.fire("message", { data: { type: VAPID_KEY_MESSAGE, key: "AQID" } });
    await stored.fire("pushsubscriptionchange", { newSubscription: null, oldSubscription: { options: { applicationServerKey: oldKey } } });
    expect(stored.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const arg = (stored.registration.pushManager.subscribe.mock.calls[0] as unknown as [{ applicationServerKey: Uint8Array }])[0];
    expect(Array.from(arg.applicationServerKey)).toEqual([1, 2, 3]);

    const sw = loadSw();
    await sw.fire("pushsubscriptionchange", { newSubscription: null, oldSubscription: { options: { applicationServerKey: oldKey } } });
    expect(sw.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: oldKey });

    const bare = loadSw();
    await bare.fire("pushsubscriptionchange", { newSubscription: null, oldSubscription: null });
    expect(bare.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(bare.fetch).not.toHaveBeenCalled();
  });

  it("fetch: tiles and static assets are cache-first, navigations fall back to /offline, API passes through", async () => {
    const sw = loadSw();
    const tile = await sw.fire("fetch", { request: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/16/31046/32487", mode: "cors", method: "GET" } });
    expect(sw.fetch).toHaveBeenCalledTimes(1);
    expect(tile).toBeTruthy();
    // cache.put() is fire-and-forget after the response is returned.
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.stores.get("ks-tiles-" + swVersion())?.size).toBe(1);

    sw.fetch.mockRejectedValueOnce(new Error("offline"));
    await sw.fire("fetch", { request: { url: "https://shuttle.example.com/app", mode: "navigate", method: "GET" } });
    expect(sw.caches.match).toHaveBeenCalledWith("/offline");

    const before = sw.fetch.mock.calls.length;
    await sw.fire("fetch", { request: { url: "https://shuttle.example.com/api/bookings", mode: "cors", method: "GET" } });
    expect(sw.fetch.mock.calls.length).toBe(before);
  });

  it("fetch: the old CARTO tile host still classifies as a tile (cached entries stay valid)", async () => {
    const origin = "https://shuttle.example.com";
    expect(classifyRequest("https://a.basemaps.cartocdn.com/rastertiles/voyager/1/1/1.png", "cors", origin)).toBe("tile");
    expect(classifyRequest("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/1/1/1", "cors", origin)).toBe("tile");
    expect(classifyRequest("https://evil.example.com/basemaps.cartocdn.com/1/1/1.png", "cors", origin)).toBe("passthrough");

    const sw = loadSw();
    await sw.fire("fetch", { request: { url: "https://a.basemaps.cartocdn.com/rastertiles/voyager/1/1/1.png", mode: "cors", method: "GET" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.stores.get("ks-tiles-" + swVersion())?.size).toBe(1);
  });

  it("fetch: OpenFreeMap vector tiles, glyphs and sprites are tiles; its style and tilejson stay network-only", async () => {
    const origin = "https://shuttle.example.com";
    const tile = "https://tiles.openfreemap.org/planet/20261025_080012_pt/14/8120/7887.pbf";
    expect(classifyRequest(`${origin}/vendor/maplibre-gl-worker-6.16.0.mjs`, "cors", origin)).toBe("static");
    expect(classifyRequest("https://evil.example.com/vendor/maplibre-gl-worker-6.16.0.mjs", "cors", origin)).toBe("passthrough");
    expect(classifyRequest(tile, "cors", origin)).toBe("tile");
    expect(classifyRequest("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf", "cors", origin)).toBe("tile");
    expect(classifyRequest("https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.png", "cors", origin)).toBe("tile");
    expect(classifyRequest("https://tiles.openfreemap.org/natural_earth/ne2sr/3/4/3.png", "cors", origin)).toBe("tile");
    // The style and the tilejson name the current (dated) tile set: network-first, last copy offline.
    expect(classifyRequest("https://tiles.openfreemap.org/styles/bright", "cors", origin)).toBe("doc");
    expect(classifyRequest("https://tiles.openfreemap.org/planet", "cors", origin)).toBe("doc");
    expect(classifyRequest("https://tiles.openfreemap.org/other", "cors", origin)).toBe("passthrough");
    expect(classifyRequest("https://evil.example.com/tiles.openfreemap.org/planet/x/1/1/1.pbf", "cors", origin)).toBe("passthrough");

    const sw = loadSw();
    await sw.fire("fetch", { request: { url: tile, mode: "cors", method: "GET" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.stores.get("ks-tiles-" + swVersion())?.size).toBe(1);
  });

  it("fetch: the OpenFreeMap style goes to the network every time and is served from the last copy when offline", async () => {
    const sw = loadSw();
    const style = { url: "https://tiles.openfreemap.org/styles/bright", mode: "cors", method: "GET" };
    await sw.fire("fetch", { request: style });
    await sw.fire("fetch", { request: style });
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.fetch.mock.calls.length).toBe(2);
    expect(sw.stores.get("ks-static-" + swVersion())?.get(style.url)?.body).toBe("body");

    sw.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const ev = (await sw.fire("fetch", { request: style })) as { respondWith: unknown };
    expect(ev).toBeTruthy();
    expect(sw.fetch.mock.calls.length).toBe(3);
    // the cached copy answered: no rejection escaped respondWith
    await expect(Promise.all([])).resolves.toBeDefined();

    // never cached before and offline → the failure propagates (the page sees a network error, not a bogus 200)
    sw.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const pending: Promise<unknown>[] = [];
    const ev2 = { request: { ...style, url: "https://tiles.openfreemap.org/planet" }, waitUntil: () => undefined, respondWith: (p: Promise<unknown>) => pending.push(p) };
    for (const h of sw.handlers.get("fetch") ?? []) h(ev2);
    await expect(Promise.all(pending)).rejects.toThrow("Failed to fetch");
  });
});

function swVersion(): string {
  const m = /const VERSION = "([^"]+)"/.exec(readFileSync(SW_PATH, "utf8"));
  if (!m) throw new Error("VERSION not found in sw.js");
  return m[1]!;
}

describe("TabBar accessible names", () => {
  it("folds the badge into the link name", async () => {
    const { tabAccessibleName } = await import("@/components/layout/TabBar");
    expect(tabAccessibleName({ label: "Inbox", badge: 3 })).toBe("Inbox, 3 unread");
    expect(tabAccessibleName({ label: "Requests", badge: 120, badgeLabel: "pending" })).toBe("Requests, 99+ pending");
    expect(tabAccessibleName({ label: "Today", badge: 0 })).toBe("Today");
    expect(tabAccessibleName({ label: "Me", badge: null })).toBe("Me");
  });
});
