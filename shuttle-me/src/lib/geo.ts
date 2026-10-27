export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees 0..360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/**
 * Shortest distance in metres from `point` to the polyline `line` (point-to-segment
 * on an equirectangular projection centred on the point: accurate to well under 1 %
 * at city scale, which is all the "is the bus still on its route?" check needs).
 * Infinity for an empty line.
 */
export function distanceToPolylineM(point: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Number.POSITIVE_INFINITY;
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const cosLat = Math.cos(toRad(point.lat));
  const project = (p: LatLng) => ({ x: (p.lng - point.lng) * cosLat * k, y: (p.lat - point.lat) * k });
  let best = Number.POSITIVE_INFINITY;
  let a = project(line[0]!);
  if (line.length === 1) return Math.hypot(a.x, a.y);
  for (let i = 1; i < line.length; i++) {
    const b = project(line[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    // The point is at the origin: t is where its foot falls on the segment, clamped to the ends.
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * dx + a.y * dy) / len2));
    const d = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (d < best) best = d;
    a = b;
  }
  return best;
}

export type Fix = LatLng & {
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  at: number; // epoch ms
};

export const TRACKING_DEFAULTS = {
  maxAccuracyM: 100,
  minDistanceM: 15,
  minIntervalMs: 3_000,
  maxIntervalMs: 10_000,
  heartbeatMs: 30_000,
} as const;

export type TrackingOptions = { -readonly [K in keyof typeof TRACKING_DEFAULTS]: number };

/**
 * Decide whether a new GPS fix is worth sending.
 * - discard inaccurate fixes (> maxAccuracyM)
 * - never send more often than minIntervalMs
 * - otherwise send if moved >= minDistanceM, or maxIntervalMs elapsed, or heartbeat due
 */
export function shouldSendFix(
  prev: Fix | null,
  next: Fix,
  opts: Partial<TrackingOptions> = {},
): { send: boolean; reason: string } {
  const o = { ...TRACKING_DEFAULTS, ...opts };
  if (next.accuracy != null && next.accuracy > o.maxAccuracyM) return { send: false, reason: "inaccurate" };
  if (!prev) return { send: true, reason: "first" };
  const dt = next.at - prev.at;
  if (dt < o.minIntervalMs) return { send: false, reason: "too-soon" };
  const dist = haversineM(prev, next);
  if (dist >= o.minDistanceM) return { send: true, reason: "moved" };
  if (dt >= o.heartbeatMs) return { send: true, reason: "heartbeat" };
  if (dt >= o.maxIntervalMs && dist >= o.minDistanceM / 3) return { send: true, reason: "interval" };
  return { send: false, reason: "stationary" };
}

/** "120 m", "1.4 km", "12 km" */
export function formatDistance(meters: number | null | undefined): string | null {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null;
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

/** "under 1 min", "4 min", "1 h 5 min" */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "under 1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Rough ETA from straight-line distance at a typical urban shuttle speed. */
export function estimateEtaSeconds(meters: number, avgSpeedMps = 6.5): number {
  // 6.5 m/s ≈ 23 km/h, which is about right for Kumasi traffic with stops.
  return Math.round((meters * 1.3) / avgSpeedMps);
}

/** Detect iOS / standalone PWA on the client. */
export function detectPlatform(ua: string, maxTouchPoints = 0, platform = ""): "ios" | "android" | "desktop" | "other" {
  if (/iphone|ipad|ipod/i.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1)) return "ios";
  if (/android/i.test(ua)) return "android";
  if (/windows|macintosh|linux/i.test(ua)) return "desktop";
  return "other";
}
