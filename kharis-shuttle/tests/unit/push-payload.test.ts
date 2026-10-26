import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://shuttle.example.com/";
});

import { MAX_PAYLOAD_BYTES, buildPayload, serializePayload, toSameOriginPath, truncateEscaped } from "@/lib/push/payload";

const SW_LOGIC = path.resolve(__dirname, "../../src/lib/push/sw-logic.ts");
const hasSwLogic = existsSync(SW_LOGIC);

const row = {
  id: "9f1c6c1e-0000-4000-8000-000000000001",
  kind: "trip_reminder" as const,
  title: "Shuttle at 7:30 AM",
  body: "3/14 seats left. GH₵10 cash. Tap to opt in.",
  url: "/app/trips/abc",
  collapse_tag: "trip:abc",
};

describe("buildPayload", () => {
  it("has the agreed shape", () => {
    expect(buildPayload(row)).toEqual({
      title: "Shuttle at 7:30 AM",
      body: "3/14 seats left. GH₵10 cash. Tap to opt in.",
      url: "/app/trips/abc",
      tag: "trip:abc",
      kind: "trip_reminder",
      id: row.id,
    });
  });
  it("falls back to the kind as tag and /app as url", () => {
    const p = buildPayload({ ...row, collapse_tag: null, url: null });
    expect(p.tag).toBe("trip_reminder");
    expect(p.url).toBe("/app");
  });
  it("keeps urls same-origin", () => {
    expect(toSameOriginPath("/app/inbox")).toBe("/app/inbox");
    expect(toSameOriginPath("https://shuttle.example.com/app/trips/1?x=1")).toBe("/app/trips/1?x=1");
    expect(toSameOriginPath("https://evil.example.com/app")).toBe("/app");
    expect(toSameOriginPath("//evil.example.com/app")).toBe("/app");
    expect(toSameOriginPath("javascript:alert(1)")).toBe("/app");
    expect(toSameOriginPath("")).toBe("/app");
    expect(toSameOriginPath(undefined)).toBe("/app");
  });
  it("passes icon and badge through only when set", () => {
    expect(buildPayload({ ...row, icon: "/icons/app/icon-192.png" }).icon).toBe("/icons/app/icon-192.png");
    expect("icon" in buildPayload(row)).toBe(false);
  });
  it("defaults an empty title", () => {
    expect(buildPayload({ ...row, title: "  " }).title).toBe("Kharis Shuttle");
  });
});

describe("3 KB guard", () => {
  it("truncates a huge body so the JSON stays within MAX_PAYLOAD_BYTES", () => {
    const p = buildPayload({ ...row, body: "GH₵ ".repeat(5_000) });
    const json = JSON.stringify(p);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(p.body.endsWith("…")).toBe(true);
    expect(p.title).toBe(row.title);
    expect(serializePayload(p)).toBe(json);
  });
  it("cuts the title too when it is the problem", () => {
    const p = buildPayload({ ...row, title: "x".repeat(10_000), body: "y".repeat(10_000) });
    expect(Buffer.byteLength(JSON.stringify(p), "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(p.title.length).toBeLessThan(10_000);
  });
  it("serializePayload squeezes a hand-built payload", () => {
    const json = serializePayload({ ...buildPayload(row), body: "z".repeat(10_000) });
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(json).tag).toBe("trip:abc");
  });
  it("leaves normal payloads alone", () => {
    expect(serializePayload(buildPayload(row))).toBe(JSON.stringify(buildPayload(row)));
  });

  describe("measures the JSON-escaped size, not the raw characters", () => {
    const wireBytes = (p: unknown) => Buffer.byteLength(JSON.stringify(p), "utf8");

    it.each([
      ["newlines and quotes", '"line"\n'.repeat(2_000)],
      ["backslashes", "C:\\path\\".repeat(2_000)],
      ["control characters (6 bytes each once escaped)", "\u0001\u0002\u0003".repeat(3_000)],
      ["tabs and carriage returns", "a\t\r\n".repeat(3_000)],
      ["multi-byte text", "GH₵ 10 — Accra 🚌 ".repeat(1_000)],
      ["a lone quote-heavy line", '"'.repeat(5_000)],
    ])("%s", (_label, body) => {
      const p = buildPayload({ ...row, body });
      expect(wireBytes(p)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(p.body.endsWith("…")).toBe(true);
      expect(p.body.length).toBeLessThan(body.length);
      expect(p.title).toBe(row.title);
      expect(serializePayload(p)).toBe(JSON.stringify(p));
    });

    it("uses the room it has: the escaped body lands close to the limit", () => {
      const p = buildPayload({ ...row, body: '"\n'.repeat(5_000) });
      expect(wireBytes(p)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(wireBytes(p)).toBeGreaterThan(MAX_PAYLOAD_BYTES - 8);
    });

    it("cuts an escape-heavy title and a huge url / tag too, and never loops forever", () => {
      const p = buildPayload({
        ...row,
        title: '"\\'.repeat(5_000),
        body: "\n".repeat(5_000),
        url: `/app/${"x".repeat(5_000)}`,
        collapse_tag: "\t".repeat(5_000),
        icon: `/icons/${"i".repeat(2_000)}.png`,
      });
      expect(wireBytes(p)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      expect(p.url).toBe("/app");
      expect(p.icon).toBeUndefined();
      expect(p.id).toBe(row.id);
      expect(p.kind).toBe("trip_reminder");
    });

    it("truncateEscaped keeps whole characters and fits the escaped budget exactly", () => {
      const s = "é\n".repeat(100); // 2 + 2 escaped bytes per pair
      const out = truncateEscaped(s, 50);
      expect(Buffer.byteLength(JSON.stringify(out), "utf8") - 2).toBeLessThanOrEqual(50);
      expect(out.endsWith("…")).toBe(true);
      expect(truncateEscaped("short", 100)).toBe("short");
      expect(truncateEscaped("too long", 2)).toBe(""); // no room even for the ellipsis
      expect(truncateEscaped("too long", 3)).toBe("…");
    });
  });
});

describe("sw-logic (service worker decisions)", () => {
  test.skipIf(!hasSwLogic)("parsePushPayload accepts JSON text, objects, plain text and nothing", async () => {
    const sw = await import("@/lib/push/sw-logic");
    const payload = buildPayload(row);
    expect(sw.parsePushPayload(JSON.stringify(payload))).toMatchObject({ title: payload.title, body: payload.body, url: payload.url, tag: "trip:abc" });
    expect(sw.parsePushPayload(payload)).toMatchObject({ id: row.id, kind: "trip_reminder" });
    expect(sw.parsePushPayload("just text")).toMatchObject({ title: sw.DEFAULT_TITLE, body: "just text", url: sw.DEFAULT_URL });
    expect(sw.parsePushPayload(null)).toMatchObject({ title: sw.DEFAULT_TITLE, url: sw.DEFAULT_URL });
  });

  test.skipIf(!hasSwLogic)("notificationOptionsFor builds showNotification arguments", async () => {
    const sw = await import("@/lib/push/sw-logic");
    const spec = sw.notificationOptionsFor(sw.parsePushPayload(JSON.stringify(buildPayload(row))));
    expect(spec.title).toBe(row.title);
    expect(spec.options.body).toBe(row.body);
    expect(spec.options.tag).toBe("trip:abc");
    expect(spec.options.icon).toBe(sw.ICON_URL);
    expect(spec.options.badge).toBe(sw.BADGE_URL);
    expect(spec.options.data).toEqual({ url: "/app/trips/abc", id: row.id, kind: "trip_reminder" });
    expect(spec.options.renotify).toBeUndefined();

    const urgent = sw.notificationOptionsFor(
      sw.parsePushPayload(JSON.stringify(buildPayload({ ...row, kind: "pickup_request_new", collapse_tag: null }))),
    );
    expect(urgent.options.renotify).toBe(true);
    expect(urgent.options.tag).toBe("pickup_request_new");
  });

  test.skipIf(!hasSwLogic)("resolveClickUrl stays on our origin", async () => {
    const sw = await import("@/lib/push/sw-logic");
    const origin = "https://shuttle.example.com";
    expect(sw.resolveClickUrl({ url: "/app/trips/1" }, origin)).toBe("https://shuttle.example.com/app/trips/1");
    expect(sw.resolveClickUrl({ url: "https://shuttle.example.com/app/inbox" }, origin)).toBe("https://shuttle.example.com/app/inbox");
    expect(sw.resolveClickUrl({ url: "https://evil.example.com/" }, origin)).toBe("https://shuttle.example.com/app");
    expect(sw.resolveClickUrl({ url: "//evil.example.com/" }, origin)).toBe("https://shuttle.example.com/app");
    expect(sw.resolveClickUrl(null, origin)).toBe("https://shuttle.example.com/app");
    expect(sw.resolveClickUrl({ url: "" }, `${origin}/`)).toBe("https://shuttle.example.com/app");
  });
});
