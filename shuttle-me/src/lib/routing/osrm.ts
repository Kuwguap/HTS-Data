import "server-only";

import { haversineM, type LatLng } from "@/lib/geo";

/**
 * Thin client for an OSRM router (default: the public demo server, which is
 * rate-limited and best-effort). Every call is time-boxed, cached in memory and
 * NEVER throws: a slow, down or refusing router simply yields `null` and the map
 * falls back to straight lines. Server only — the base URL is `ROUTER_BASE_URL`.
 */

export type RouteLeg = { distanceM: number; durationS: number };
export type RouteResult = { geometry: LatLng[]; distanceM: number; durationS: number; legs: RouteLeg[] };
/** `fromAt`/`throughAt`: epoch ms of the first and last fix the geometry covers. */
export type MatchResult = { geometry: LatLng[]; confidence: number; fromAt: number; throughAt: number };
/** One GPS fix of a trace, oldest first. `at` is epoch milliseconds. */
export type TracePoint = LatLng & { at: number; accuracyM?: number | null };

const DEFAULT_BASE_URL = "https://router.project-osrm.org";
const TIMEOUT_MS = 6_000;
const ROUTE_TTL_MS = 45_000;
const MATCH_TTL_MS = 15_000;
/** A failed call is remembered briefly so a down router is not hammered by every viewer. */
const FAILURE_TTL_MS = 10_000;
const CACHE_MAX = 200;
/** Fixes loaded per trip for matching (the DB window); the trace is chunked below. */
export const MATCH_MAX_POINTS = 100;
/**
 * Coordinates per match request. The public demo server rejects traces above 10
 * ("Too many trace coordinates", verified: 10 → Ok, 12 → TooBig); a self-hosted
 * OSRM accepts 100 — set ROUTER_MATCH_CHUNK_POINTS accordingly.
 */
export const MATCH_CHUNK_POINTS = (() => {
  const n = Number.parseInt(process.env.ROUTER_MATCH_CHUNK_POINTS ?? "", 10);
  return Number.isInteger(n) && n >= 2 && n <= 100 ? n : 10;
})();
/** Fixes closer than this to the previous kept fix are dropped before matching (stationary bus). */
const MATCH_THIN_M = 15;
/** Chunks are 90 s time buckets so their boundaries stay put as the 100-fix window slides. */
const BUCKET_MS = 90_000;
/** A matched chunk is kept for 10 min: its fixes never change once the bucket is complete. */
const CHUNK_TTL_MS = 10 * 60_000;
/** Chunks matched per request (newest first); older ones fill in on later requests. */
const MAX_CHUNKS_PER_CALL = 6;
const CHUNK_CONCURRENCY = 2;
const RADIUS_DEFAULT_M = 25;
const RADIUS_MIN_M = 10;
// The public OSRM demo server answers HTTP 400 "TooBig" for any match radius above 40 m
// (verified: 40 → Ok, 41 → TooBig), and one oversized radius fails the whole trace.
const RADIUS_MAX_M = 40;

function baseUrl(): string {
  return (process.env.ROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

type Entry<T> = { expiresAt: number; value: Promise<T | null> };

/** Tiny insertion-ordered TTL cache; concurrent callers share the in-flight promise. */
class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();
  constructor(private readonly max: number) {}

  get(key: string): Promise<T | null> | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: Promise<T | null>, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { expiresAt: Date.now() + ttlMs, value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  shorten(key: string, ttlMs: number): void {
    const e = this.map.get(key);
    if (e) e.expiresAt = Math.min(e.expiresAt, Date.now() + ttlMs);
  }

  clear(): void {
    this.map.clear();
  }
}

const routeCache = new TtlCache<RouteResult>(CACHE_MAX);
const matchCache = new TtlCache<MatchResult>(CACHE_MAX);
/** Snapped pieces of traces, keyed by chunk content (see chunkTrace); a trip of 100 fixes is ~12 entries. */
const chunkCache = new TtlCache<MatchResult>(CACHE_MAX * 4);

/** Tests only: forget every cached answer (routes, whole traces and per-chunk matches). */
export function clearRouterCache(): void {
  routeCache.clear();
  matchCache.clear();
  chunkCache.clear();
}

async function cached<T>(cache: TtlCache<T>, key: string, ttlMs: number, compute: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = compute();
  cache.set(key, pending, ttlMs);
  const value = await pending;
  if (value === null) cache.shorten(key, FAILURE_TTL_MS);
  return value;
}

/** GET `url` as JSON within TIMEOUT_MS; null (logged) on timeout, network error, non-2xx or bad JSON. */
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn("[router] request failed", res.status, url.split("?")[0]);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[router] request error", err instanceof Error ? err.message : err, url.split("?")[0]);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** OSRM wants `lng,lat;lng,lat;…`. */
function coordPath(points: LatLng[]): string {
  return points.map((p) => `${p.lng},${p.lat}`).join(";");
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** GeoJSON `[lng, lat]` pairs → LatLng[] (malformed entries dropped). */
function geojsonLine(geometry: unknown): LatLng[] | null {
  const coords = (geometry as { coordinates?: unknown } | null)?.coordinates;
  if (!Array.isArray(coords)) return null;
  const out: LatLng[] = [];
  for (const c of coords) {
    if (Array.isArray(c) && isNum(c[0]) && isNum(c[1])) out.push({ lat: c[1], lng: c[0] });
  }
  return out;
}

/**
 * Driving route through `points` in order (2+ points: from, optional via stops, to).
 * Cached 45 s by the coordinates rounded to 4 decimals (~10 m).
 */
export async function routeVia(points: LatLng[]): Promise<RouteResult | null> {
  if (points.length < 2 || points.some((p) => !isNum(p.lat) || !isNum(p.lng))) return null;
  const key = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");
  return cached(routeCache, key, ROUTE_TTL_MS, async () => {
    const url = `${baseUrl()}/route/v1/driving/${coordPath(points)}?overview=full&geometries=geojson&steps=false&alternatives=false`;
    const data = (await fetchJson(url)) as { code?: string; routes?: unknown[] } | null;
    if (!data || data.code !== "Ok" || !Array.isArray(data.routes)) {
      if (data) console.warn("[router] route not Ok", data.code);
      return null;
    }
    const r = data.routes[0] as { geometry?: unknown; distance?: unknown; duration?: unknown; legs?: unknown } | undefined;
    const geometry = r ? geojsonLine(r.geometry) : null;
    if (!r || !geometry || geometry.length < 2 || !isNum(r.distance) || !isNum(r.duration)) return null;
    const legs: RouteLeg[] = (Array.isArray(r.legs) ? r.legs : [])
      .filter((l): l is { distance: number; duration: number } => isNum((l as { distance?: unknown })?.distance) && isNum((l as { duration?: unknown })?.duration))
      .map((l) => ({ distanceM: l.distance, durationS: l.duration }));
    return { geometry, distanceM: r.distance, durationS: r.duration, legs };
  });
}

/**
 * The fixes actually sent to the matcher: timestamps strictly increasing (in whole
 * seconds; others dropped), thinned to one per ≥ 15 m (the first and the newest fix
 * always stay so the snapped trail reaches the bus), and the last 100 at most.
 */
export function prepareTrace(points: TracePoint[]): TracePoint[] {
  const kept: TracePoint[] = [];
  let lastSec = -Infinity;
  for (const p of points) {
    if (!isNum(p.lat) || !isNum(p.lng) || !isNum(p.at)) continue;
    const sec = Math.floor(p.at / 1000);
    if (sec <= lastSec) continue;
    lastSec = sec;
    kept.push(p);
  }
  const last = kept[kept.length - 1];
  const thinned: TracePoint[] = [];
  for (const p of kept) {
    const prev = thinned[thinned.length - 1];
    if (!prev || p === last || haversineM(prev, p) >= MATCH_THIN_M) thinned.push(p);
  }
  return thinned.length > MATCH_MAX_POINTS ? thinned.slice(thinned.length - MATCH_MAX_POINTS) : thinned;
}

function radiusFor(accuracyM: number | null | undefined): number {
  if (!isNum(accuracyM) || accuracyM <= 0) return RADIUS_DEFAULT_M;
  return Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, Math.round(accuracyM)));
}

export type TraceChunk = { key: string; points: TracePoint[] };

/**
 * Split a prepared trace into match requests of at most MATCH_CHUNK_POINTS
 * coordinates. Chunks follow 90 s time buckets (split further by count when a
 * bucket is dense) and each one ends with the first fix of the next chunk, so
 * consecutive snapped pieces join on a shared point. The key identifies the chunk's
 * exact content, so a completed bucket is cached until it leaves the window and only
 * the live (newest) bucket is re-matched as fixes arrive.
 */
export function chunkTrace(trace: TracePoint[]): TraceChunk[] {
  const groups: TracePoint[][] = [];
  const perGroup = Math.max(1, MATCH_CHUNK_POINTS - 1);
  let bucket = Number.NaN;
  for (const p of trace) {
    const b = Math.floor(p.at / BUCKET_MS);
    const current = groups[groups.length - 1];
    if (b !== bucket || !current || current.length >= perGroup) {
      groups.push([p]);
      bucket = b;
    } else {
      current.push(p);
    }
  }
  const chunks: TraceChunk[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const next = groups[i + 1]?.[0];
    const points = next ? [...g, next] : g;
    if (points.length < 2) continue;
    chunks.push({ key: `${Math.floor(g[0]!.at / BUCKET_MS)}:${g[0]!.at}:${points[points.length - 1]!.at}:${points.length}`, points });
  }
  return chunks;
}

/** One OSRM match request for ≤ MATCH_CHUNK_POINTS fixes. */
async function matchChunk(points: TracePoint[]): Promise<MatchResult | null> {
  const radiuses = points.map((p) => radiusFor(p.accuracyM)).join(";");
  const timestamps = points.map((p) => Math.floor(p.at / 1000)).join(";");
  const url =
    `${baseUrl()}/match/v1/driving/${coordPath(points)}` +
    `?overview=full&geometries=geojson&tidy=true&gaps=ignore&radiuses=${radiuses}&timestamps=${timestamps}`;
  const data = (await fetchJson(url)) as { code?: string; matchings?: unknown[] } | null;
  if (!data || data.code !== "Ok" || !Array.isArray(data.matchings)) {
    if (data) console.warn("[router] match not Ok", data.code);
    return null;
  }
  // gaps=ignore normally yields one matching; if the trace was split anyway, chain the pieces.
  const geometry: LatLng[] = [];
  let confidence = 1;
  for (const m of data.matchings as Array<{ geometry?: unknown; confidence?: unknown }>) {
    const line = geojsonLine(m?.geometry);
    if (!line) continue;
    geometry.push(...line);
    if (isNum(m.confidence)) confidence = Math.min(confidence, m.confidence);
  }
  if (geometry.length < 2) return null;
  return { geometry, confidence, fromAt: points[0]!.at, throughAt: points[points.length - 1]!.at };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}


/**
 * Snap a GPS trace (oldest first) to the road network, chunk by chunk (the public
 * router takes ≤ 10 coordinates per request). `cacheKey` identifies the whole trace
 * (trip id + newest point id; answers kept 15 s); `chunkPrefix` (default: the part of
 * `cacheKey` before the first ":", i.e. the trip id) scopes the per-chunk cache.
 * Returns the latest contiguous run of snapped chunks, so the geometry is continuous
 * and `fromAt`/`throughAt` tell the caller which fixes it covers (raw fixes are
 * drawn outside that window). At most 6 chunks are fetched per call, newest first;
 * the rest fill in from cache on later calls.
 */
export async function matchTrace(points: TracePoint[], cacheKey: string, chunkPrefix?: string): Promise<MatchResult | null> {
  const trace = prepareTrace(points);
  if (trace.length < 2) return null;
  const prefix = chunkPrefix ?? cacheKey.split(":")[0] ?? cacheKey;
  return cached(matchCache, cacheKey, MATCH_TTL_MS, async () => {
    const chunks = chunkTrace(trace).slice(-MAX_CHUNKS_PER_CALL);
    const results = await mapLimit(chunks, CHUNK_CONCURRENCY, (c) =>
      cached(chunkCache, `${prefix}:${c.key}`, CHUNK_TTL_MS, () => matchChunk(c.points)),
    );
    // Latest contiguous run of successful chunks.
    let end = results.length - 1;
    while (end >= 0 && !results[end]) end--;
    if (end < 0) return null;
    let start = end;
    while (start > 0 && results[start - 1]) start--;
    const geometry: LatLng[] = [];
    let confidence = 1;
    for (let i = start; i <= end; i++) {
      const r = results[i]!;
      for (const p of r.geometry) {
        const prev = geometry[geometry.length - 1];
        if (prev && Math.abs(prev.lat - p.lat) < 1e-7 && Math.abs(prev.lng - p.lng) < 1e-7) continue;
        geometry.push(p);
      }
      confidence = Math.min(confidence, r.confidence);
    }
    if (geometry.length < 2) return null;
    return { geometry, confidence, fromAt: results[start]!.fromAt, throughAt: results[end]!.throughAt };
  });
}
