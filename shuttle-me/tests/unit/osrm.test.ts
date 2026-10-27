/**
 * src/lib/routing/osrm.ts — URL shape (lng,lat order, params), timestamp / radius
 * handling, the 6 s time-box, non-Ok answers and the in-memory caches. `fetch` is
 * stubbed; nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearRouterCache, matchTrace, prepareTrace, routeVia, type TracePoint } from "@/lib/routing/osrm";

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

  it("is keyed by the caller's cache key for 15 s", async () => {
    fetchMock.mockResolvedValue(jsonResponse(matchBody));
    const a = await matchTrace(trace, "trip:4");
    const b = await matchTrace(trace, "trip:4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    await matchTrace(trace, "trip:5");
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
  it("sends at most the last 100 fixes, thinned to one per ≥ 10 m when there are more", () => {
    // 300 fixes 5 m apart (≈ 0.000045° of latitude), one per second.
    const many: TracePoint[] = Array.from({ length: 300 }, (_, i) => ({ lat: 6.67 + i * 0.000045, lng: -1.57, at: T0 + i * 1000 }));
    const out = prepareTrace(many);
    expect(out).toHaveLength(100);
    expect(out[out.length - 1]).toBe(many[299]);
    // thinning kept every other fix (10 m apart), so the window spans ~200 of the originals
    expect(out[0]!.at).toBeGreaterThanOrEqual(many[100]!.at);
    expect(out[0]!.at).toBeLessThanOrEqual(many[102]!.at);
    for (let i = 1; i < out.length; i++) expect(out[i]!.at).toBeGreaterThan(out[i - 1]!.at);
  });

  it("leaves a short trace alone", () => {
    expect(prepareTrace(trace)).toEqual(trace);
  });
});
