import { describe, expect, it } from "vitest";
import {
  TRACKING_DEFAULTS,
  bearingDeg,
  detectPlatform,
  distanceToPolylineM,
  estimateEtaSeconds,
  formatDistance,
  formatEta,
  haversineM,
  shouldSendFix,
  type Fix,
} from "@/lib/geo";

const KNUST_GATE = { lat: 6.683, lng: -1.577 };
const KEJETIA = { lat: 6.696, lng: -1.62 };

describe("haversineM", () => {
  it("KNUST → Kejetia is roughly 4–6 km", () => {
    const d = haversineM(KNUST_GATE, KEJETIA);
    expect(d).toBeGreaterThan(4_000);
    expect(d).toBeLessThan(6_000);
  });
  it("is symmetric and zero for the same point", () => {
    expect(haversineM(KNUST_GATE, KEJETIA)).toBeCloseTo(haversineM(KEJETIA, KNUST_GATE), 6);
    expect(haversineM(KNUST_GATE, KNUST_GATE)).toBe(0);
  });
  it("one degree of latitude is about 111 km", () => {
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -2);
  });
});

describe("distanceToPolylineM", () => {
  // A north–south road of ~1.1 km near KNUST, then a bend to the east.
  const road = [
    { lat: 6.67, lng: -1.57 },
    { lat: 6.68, lng: -1.57 },
    { lat: 6.68, lng: -1.56 },
  ];
  it("is ~0 for a point on a segment", () => {
    expect(distanceToPolylineM({ lat: 6.675, lng: -1.57 }, road)).toBeLessThan(0.01);
    expect(distanceToPolylineM({ lat: 6.68, lng: -1.565 }, road)).toBeLessThan(0.01);
  });
  it("measures the perpendicular offset for a point beside the line", () => {
    // 0.001° of longitude at 6.68° N ≈ 110.4 m
    const d = distanceToPolylineM({ lat: 6.675, lng: -1.569 }, road);
    expect(d).toBeGreaterThan(108);
    expect(d).toBeLessThan(113);
    // the bend: 50 m off the corner diagonally is still ~50 m to the nearest segment
    expect(distanceToPolylineM({ lat: 6.6795, lng: -1.5705 }, road)).toBeGreaterThan(50);
  });
  it("uses the distance to the nearest endpoint beyond the ends", () => {
    const beyondStart = { lat: 6.669, lng: -1.57 }; // 0.001° of latitude ≈ 111 m south of the first point
    expect(distanceToPolylineM(beyondStart, road)).toBeCloseTo(haversineM(beyondStart, road[0]!), -1);
    const beyondEnd = { lat: 6.68, lng: -1.559 };
    expect(distanceToPolylineM(beyondEnd, road)).toBeCloseTo(haversineM(beyondEnd, road[2]!), -1);
  });
  it("handles degenerate lines", () => {
    expect(distanceToPolylineM({ lat: 6.67, lng: -1.57 }, [])).toBe(Number.POSITIVE_INFINITY);
    expect(distanceToPolylineM({ lat: 6.671, lng: -1.57 }, [road[0]!])).toBeCloseTo(111, -1);
    expect(distanceToPolylineM({ lat: 6.671, lng: -1.57 }, [road[0]!, road[0]!])).toBeCloseTo(111, -1);
  });
});

describe("bearingDeg", () => {
  it("north is 0, east is 90, south is 180, west is 270", () => {
    const o = { lat: 6.68, lng: -1.57 };
    expect(bearingDeg(o, { lat: 6.69, lng: -1.57 })).toBeCloseTo(0, 3);
    expect(bearingDeg(o, { lat: 6.68, lng: -1.56 })).toBeCloseTo(90, 0);
    expect(bearingDeg(o, { lat: 6.67, lng: -1.57 })).toBeCloseTo(180, 3);
    expect(bearingDeg(o, { lat: 6.68, lng: -1.58 })).toBeCloseTo(270, 0);
  });
});

function fix(overrides: Partial<Fix> = {}): Fix {
  return { lat: 6.683, lng: -1.577, accuracy: 10, heading: null, speed: null, at: 100_000, ...overrides };
}

/** ~50 m north of the base fix. */
const MOVED_50M = { lat: 6.683 + 50 / 111_195 };
/** ~7 m north. */
const MOVED_7M = { lat: 6.683 + 7 / 111_195 };

describe("shouldSendFix", () => {
  const prev = fix();
  it("discards inaccurate fixes even when it is the first one", () => {
    expect(shouldSendFix(null, fix({ accuracy: TRACKING_DEFAULTS.maxAccuracyM + 1 }))).toEqual({
      send: false,
      reason: "inaccurate",
    });
  });
  it("sends the first usable fix", () => {
    expect(shouldSendFix(null, fix())).toEqual({ send: true, reason: "first" });
    expect(shouldSendFix(null, fix({ accuracy: null }))).toEqual({ send: true, reason: "first" });
  });
  it("never sends more often than minIntervalMs", () => {
    expect(shouldSendFix(prev, fix({ ...MOVED_50M, at: prev.at + 1_000 }))).toEqual({ send: false, reason: "too-soon" });
  });
  it("sends when moved at least minDistanceM", () => {
    expect(shouldSendFix(prev, fix({ ...MOVED_50M, at: prev.at + 5_000 }))).toEqual({ send: true, reason: "moved" });
  });
  it("sends a heartbeat while stationary", () => {
    expect(shouldSendFix(prev, fix({ at: prev.at + TRACKING_DEFAULTS.heartbeatMs }))).toEqual({
      send: true,
      reason: "heartbeat",
    });
  });
  it("sends a small move once maxIntervalMs has passed", () => {
    expect(shouldSendFix(prev, fix({ ...MOVED_7M, at: prev.at + 11_000 }))).toEqual({ send: true, reason: "interval" });
  });
  it("stays quiet when stationary between heartbeats", () => {
    expect(shouldSendFix(prev, fix({ at: prev.at + 5_000 }))).toEqual({ send: false, reason: "stationary" });
    expect(shouldSendFix(prev, fix({ at: prev.at + 11_000 }))).toEqual({ send: false, reason: "stationary" });
  });
  it("honours overrides", () => {
    // TrackingOptions is `typeof TRACKING_DEFAULTS` (as const), so the literal types need a cast here.
    const opts = { minDistanceM: 5 } as unknown as Partial<typeof TRACKING_DEFAULTS>;
    expect(shouldSendFix(prev, fix({ ...MOVED_7M, at: prev.at + 5_000 }), opts)).toEqual({
      send: true,
      reason: "moved",
    });
  });
});

describe("formatDistance / formatEta", () => {
  it("rounds metres to 10 and kilometres sensibly", () => {
    expect(formatDistance(123)).toBe("120 m");
    expect(formatDistance(1_400)).toBe("1.4 km");
    expect(formatDistance(12_300)).toBe("12 km");
    expect(formatDistance(null)).toBeNull();
    expect(formatDistance(-1)).toBeNull();
    expect(formatDistance(Number.NaN)).toBeNull();
  });
  it("formats an ETA in minutes and hours", () => {
    expect(formatEta(20)).toBe("under 1 min");
    expect(formatEta(240)).toBe("4 min");
    expect(formatEta(3_900)).toBe("1 h 5 min");
    expect(formatEta(7_200)).toBe("2 h");
    expect(formatEta(0)).toBeNull();
    expect(formatEta(undefined)).toBeNull();
  });
  it("estimateEtaSeconds pads the straight line for roads", () => {
    expect(estimateEtaSeconds(6_500)).toBe(1_300);
  });
});

describe("detectPlatform", () => {
  it("recognises iPhone, iPadOS-as-Mac, Android and desktop", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5, "MacIntel")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0, "MacIntel")).toBe("desktop");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    expect(detectPlatform("curl/8")).toBe("other");
  });
});
