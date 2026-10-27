/**
 * src/lib/routing/osrm.ts — URL shape (lng,lat order, params), timestamp / radius
 * handling, the 6 s time-box, non-Ok answers and the in-memory caches. `fetch` is
 * stubbed; nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MATCH_CHUNK_POINTS, chunkTrace, clearRouterCache, matchTrace, prepareTrace, routeVia, type TracePoint } from "@/lib/routing/osrm";
import { haversineM } from "@/lib/geo";

const FROM = { lat: 6.6745, lng: -1.5716 };
const VIA = { lat: 6.672, lng: -1.569 };
const TO = { lat: 6.669, lng: -1.565 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const routeBody = {
  code: "Ok",
  routes: [
    {
      distance: 1470.2,
      duration: 255.1,
      geometry: { type: "LineString", coordinates: [[-1.5716, 6.6745], [-1.569, 6.672], [-1.565, 6.669]] },
      legs: [
        { distance: 600, duration: 100 },
        { distance: 870.2, duration: 155.1 },
      ],
    },
  ],
};

const matchBody = {
  code: "Ok",
  matchings: [{ confidence: 0.87, geometry: { type: "LineString", coordinates: [[-1.5716, 6.6745], [-1.571, 6.674], [-1.5705, 6.6735]] } }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearRouterCache();
  process.env.ROUTER_BASE_URL = "https://router.test/";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.ROUTER_BASE_URL;
});

const calledUrl = (i = 0) => new URL(String(fetchMock.mock.calls[i]![0]));

describe("routeVia", () => {
  it("asks /route/v1/driving with lng,lat pairs in order and returns LatLng geometry, totals and legs", async () => {
    fetchMock.mockResolvedValue(jsonResponse(routeBody));
    const r = await routeVia([FROM, VIA, TO]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const u = calledUrl();
    expect(u.origin).toBe("https://router.test");
    expect(u.pathname).toBe("/route/v1/driving/-1.5716,6.6745;-1.569,6.672;-1.565,6.669");
    expect(Object.fromEntries(u.searchParams)).toEqual({ overview: "full", geometries: "geojson", steps: "false", alternatives: "false" });
    expect(r).toEqual({
      geometry: [
        { lat: 6.6745, lng: -1.5716 },
        { lat: 6.672, lng: -1.569 },
        { lat: 6.669, lng: -1.565 },
      ],
      distanceM: 1470.2,
      durationS: 255.1,
      legs: [
        { distanceM: 600, durationS: 100 },
        { distanceM: 870.2, durationS: 155.1 },
      ],
    });
    // Time-boxed: the request carries an abort signal.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("serves a second call for the same (rounded) coordinates from the cache", async () => {
    fetchMock.mockResolvedValue(jsonResponse(routeBody));
    const a = await routeVia([FROM, TO]);
    const b = await routeVia([{ lat: 6.67451, lng: -1.57162 }, TO]); // within 4 decimals of FROM
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    await routeVia([{ lat: 6.6755, lng: -1.5716 }, TO]); // a different key
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is null (never throws) on a non-2xx answer, a non-Ok code, bad JSON or a network error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Too Many Requests" }, 429));
    expect(await routeVia([FROM, TO])).toBeNull();
    clearRouterCache();
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "NoRoute", routes: [] }));
    expect(await routeVia([FROM, TO])).toBeNull();
    clearRouterCache();
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await routeVia([FROM, TO])).toBeNull();
    clearRouterCache();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await routeVia([FROM, TO])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after 6 s and returns null", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    const pending = routeVia([FROM, TO]);
    await vi.advanceTimersByTimeAsync(5_900);
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBeNull();
  });

  it("needs at least two finite points", async () => {
    expect(await routeVia([FROM])).toBeNull();
    expect(await routeVia([FROM, { lat: Number.NaN, lng: 0 }])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const T0 = Date.UTC(2026, 9, 27, 8, 0, 0);
const trace: TracePoint[] = [
  { lat: 6.6745, lng: -1.5716, at: T0, accuracyM: 8 },
  { lat: 6.674, lng: -1.571, at: T0 + 5_000, accuracyM: null },
  { lat: 6.6735, lng: -1.5705, at: T0 + 12_000, accuracyM: 120 },
  { lat: 6.673, lng: -1.57, at: T0 + 20_000, accuracyM: 33.4 },
];

describe("matchTrace", () => {
  it("asks /match/v1/driving with tidy + gaps=ignore, clamped radiuses and unix-second timestamps", async () => {
    fetchMock.mockResolvedValue(jsonResponse(matchBody));
    const m = await matchTrace(trace, "trip:4");
    const u = calledUrl();
    expect(u.pathname).toBe("/match/v1/driving/-1.5716,6.6745;-1.571,6.674;-1.5705,6.6735;-1.57,6.673");
    expect(u.searchParams.get("overview")).toBe("full");
    expect(u.searchParams.get("geometries")).toBe("geojson");
    expect(u.searchParams.get("tidy")).toBe("true");
    expect(u.searchParams.get("gaps")).toBe("ignore");
    // 8 → 10 (min), null → 25 (default), 120 → 40 (max: the public OSRM server rejects radii above 40 with TooBig), 33.4 → 33
    expect(u.searchParams.get("radiuses")).toBe("10;25;40;33");
    const s = Math.floor(T0 / 1000);
    expect(u.searchParams.get("timestamps")).toBe(`${s};${s + 5};${s + 12};${s + 20}`);
    expect(m).toEqual({
      geometry: [
        { lat: 6.6745, lng: -1.5716 },
        { lat: 6.674, lng: -1.571 },
        { lat: 6.6735, lng: -1.5705 },
      ],
      confidence: 0.87,
      fromAt: T0,
      throughAt: T0 + 20_000,
    });
  });

  it("drops fixes whose timestamp does not strictly increase", async () => {
    fetchMock.mockResolvedValue(jsonResponse(matchBody));
    const noisy: TracePoint[] = [
      trace[0]!,
      { ...trace[1]!, at: T0 + 400 }, // same second as the first → dropped
      trace[1]!,
      { ...trace[2]!, at: T0 + 2_000 }, // goes backwards → dropped
      trace[3]!,
    ];
    await matchTrace(noisy, "trip:5");
    const u = calledUrl();
    expect(u.pathname.split("/").pop()!.split(";")).toHaveLength(3);
    const s = Math.floor(T0 / 1000);
    expect(u.searchParams.get("timestamps")).toBe(`${s};${s + 5};${s + 20}`);
  });

  it("is keyed by the caller's cache key for 15 s, and chunks by their content underneath", async () => {
    fetchMock.mockResolvedValue(jsonResponse(matchBody));
    const a = await matchTrace(trace, "trip:4");
    const b = await matchTrace(trace, "trip:4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    // A new caller key with the very same fixes is served from the per-chunk cache.
    await matchTrace(trace, "trip:5");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A new fix changes the live chunk → one more request.
    await matchTrace([...trace, { lat: 6.6725, lng: -1.5695, at: T0 + 30_000 }], "trip:6");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is null for fewer than two usable fixes, a non-Ok code or an HTTP error", async () => {
    expect(await matchTrace([trace[0]!], "k1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "NoMatch", matchings: [] }));
    expect(await matchTrace(trace, "k2")).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Too Many Requests" }, 429));
    expect(await matchTrace(trace, "k3")).toBeNull();
  });
});

describe("prepareTrace", () => {
  it("thins to one fix per ≥ 15 m (keeping the newest) and sends at most the last 100", () => {
    // 300 fixes 5 m apart (≈ 0.000045° of latitude), one per second → every third fix survives.
    const many: TracePoint[] = Array.from({ length: 300 }, (_, i) => ({ lat: 6.67 + i * 0.000045, lng: -1.57, at: T0 + i * 1000 }));
    const out = prepareTrace(many);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[out.length - 1]).toBe(many[299]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.at).toBeGreaterThan(out[i - 1]!.at);
      if (i < out.length - 1) expect(haversineM(out[i - 1]!, out[i]!)).toBeGreaterThanOrEqual(15);
    }
  });

  it("collapses a stationary bus to its first and newest fix", () => {
    const parked: TracePoint[] = Array.from({ length: 6 }, (_, i) => ({ lat: 6.67, lng: -1.57, at: T0 + i * 10_000 }));
    expect(prepareTrace(parked)).toEqual([parked[0], parked[5]]);
  });

  it("leaves a short moving trace alone", () => {
    expect(prepareTrace(trace)).toEqual(trace);
  });
});

describe("chunkTrace + chunked matching (public router: ≤ 10 coordinates per request)", () => {
  // 25 fixes, 10 s apart, 80 m apart → 250 s of driving spanning three 90 s buckets.
  const long: TracePoint[] = Array.from({ length: 25 }, (_, i) => ({ lat: 6.67 + i * 0.00072, lng: -1.57, at: T0 + i * 10_000, accuracyM: 12 }));

  it("splits by 90 s bucket, never more than MATCH_CHUNK_POINTS per chunk, with a shared joining fix", () => {
    const chunks = chunkTrace(long);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.points.length).toBeLessThanOrEqual(MATCH_CHUNK_POINTS);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.points;
      expect(prev[prev.length - 1]).toBe(chunks[i]!.points[0]);
    }
    expect(chunks[chunks.length - 1]!.points[chunks[chunks.length - 1]!.points.length - 1]).toBe(long[24]);
    // keys are content-based: same input → same keys
    expect(chunkTrace(long).map((c) => c.key)).toEqual(chunks.map((c) => c.key));
  });

  it("matches each chunk separately, joins the pieces and reports the covered window", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const coords = url.split("/match/v1/driving/")[1]!.split("?")[0]!.split(";");
      expect(coords.length).toBeLessThanOrEqual(MATCH_CHUNK_POINTS);
      const line = coords.map((c) => c.split(",").map(Number));
      return jsonResponse({ code: "Ok", matchings: [{ confidence: 0.9, geometry: { type: "LineString", coordinates: line } }] });
    });
    const r = await matchTrace(long, "trip:25");
    expect(r).not.toBeNull();
    expect(r!.fromAt).toBe(long[0]!.at);
    expect(r!.throughAt).toBe(long[24]!.at);
    expect(r!.geometry[0]).toEqual({ lat: long[0]!.lat, lng: long[0]!.lng });
    expect(r!.geometry[r!.geometry.length - 1]).toEqual({ lat: long[24]!.lat, lng: long[24]!.lng });
    // joining fixes are not duplicated
    for (let i = 1; i < r!.geometry.length; i++) expect(r!.geometry[i]).not.toEqual(r!.geometry[i - 1]);
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBe(chunkTrace(long).length);

    // One new fix later: only the live (last) chunk is fetched again; completed chunks come from cache.
    const more = [...long, { lat: 6.67 + 25 * 0.00072, lng: -1.57, at: T0 + 25 * 10_000, accuracyM: 12 }];
    const r2 = await matchTrace(more, "trip:26");
    expect(r2!.throughAt).toBe(more[25]!.at);
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
  });

  it("returns the latest contiguous run when an older chunk fails, and null when the newest fails", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url: string) => {
      n++;
      const coords = url.split("/match/v1/driving/")[1]!.split("?")[0]!.split(";");
      const line = coords.map((c) => c.split(",").map(Number));
      if (n === 1) return jsonResponse({ code: "NoMatch" }); // the oldest chunk is fetched first
      return jsonResponse({ code: "Ok", matchings: [{ confidence: 0.8, geometry: { type: "LineString", coordinates: line } }] });
    });
    const r = await matchTrace(long, "t2:25");
    expect(r).not.toBeNull();
    expect(r!.fromAt).toBeGreaterThan(long[0]!.at);
    expect(r!.throughAt).toBe(long[24]!.at);

    clearRouterCache();
    fetchMock.mockImplementation(async () => jsonResponse({ code: "TooBig" }, 400));
    expect(await matchTrace(long, "t3:25")).toBeNull();
  });
});
