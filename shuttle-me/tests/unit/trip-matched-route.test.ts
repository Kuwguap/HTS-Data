/**
 * GET /api/trips/[id]/matched — auth, the fixes query (newest 100, replayed oldest
 * first), the cache key handed to the matcher and the null-geometry answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireUser, getSettings, matchTrace } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
  getSettings: vi.fn(),
  matchTrace: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireUser, isStaff: (p: { role: string }) => p.role !== "student" }));
vi.mock("@/lib/data/settings", () => ({ getSettings }));
vi.mock("@/lib/routing/osrm", () => ({ matchTrace, MATCH_MAX_POINTS: 100 }));

import { GET } from "@/app/api/trips/[id]/matched/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const STUDENT = "55555555-0000-4000-8000-000000000001";
const TRIP = "33333333-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TRIP }) };
const request = () => new Request(`http://localhost:3100/api/trips/${TRIP}/matched`);

// As the query returns them: newest first.
const fixesDesc = [
  { id: 12, lat: 6.6735, lng: -1.5705, accuracy_m: 9, recorded_at: "2026-10-27T07:59:40+00:00" },
  { id: 11, lat: 6.674, lng: -1.571, accuracy_m: null, recorded_at: "2026-10-27T07:59:30+00:00" },
  { id: 10, lat: 6.6745, lng: -1.5716, accuracy_m: 14, recorded_at: "2026-10-27T07:59:20+00:00" },
];

const snapped = { geometry: [{ lat: 6.6745, lng: -1.5716 }, { lat: 6.6741, lng: -1.5711 }, { lat: 6.6735, lng: -1.5705 }], confidence: 0.91 };

let db: ReturnType<typeof fakeAdmin>;

function setup(trip: Record<string, unknown> | null, fixes: unknown[] = fixesDesc) {
  const respond = (call: FakeCall): FakeResult | undefined => {
    if (call.table === "trips") return { data: trip, error: null };
    if (call.table === "trip_locations") return { data: fixes, error: null };
    return undefined;
  };
  db = fakeAdmin(respond);
  createAdminClient.mockReturnValue(db.client);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  requireUser.mockReset();
  requireUser.mockResolvedValue({ user: { id: STUDENT }, profile: { id: STUDENT, role: "student", is_active: true } });
  getSettings.mockReset();
  getSettings.mockResolvedValue({ timezone: "Africa/Accra" });
  matchTrace.mockReset();
  matchTrace.mockResolvedValue(snapped);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/trips/[id]/matched", () => {
  it("401 when signed out", async () => {
    requireUser.mockRejectedValueOnce(new ApiError(401, "UNAUTHENTICATED", "Please log in."));
    setup({ id: TRIP, service_date: "2026-10-27" });
    expect((await GET(request(), ctx)).status).toBe(401);
    expect(matchTrace).not.toHaveBeenCalled();
  });

  it("404 for an unknown trip or one outside the student window", async () => {
    setup(null);
    expect((await GET(request(), ctx)).status).toBe(404);
    setup({ id: TRIP, service_date: "2026-10-20" });
    expect((await GET(request(), ctx)).status).toBe(404);
    expect(matchTrace).not.toHaveBeenCalled();
  });

  it("loads the newest 100 fixes, replays them oldest first and keys the cache by trip + newest id", async () => {
    setup({ id: TRIP, service_date: "2026-10-27" });
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=15");

    const q = db.calls.find((c) => c.table === "trip_locations")!;
    expect(filterOf(q, "eq", "trip_id")?.args[1]).toBe(TRIP);
    expect(filterOf(q, "order", "id")?.args[1]).toEqual({ ascending: false });
    expect(q.filters.find((f) => f.method === "limit")?.args[0]).toBe(100);

    expect(matchTrace).toHaveBeenCalledTimes(1);
    const [trace, key] = matchTrace.mock.calls[0]!;
    expect(trace.map((p: { lat: number }) => p.lat)).toEqual([6.6745, 6.674, 6.6735]);
    expect(trace[0]).toEqual({ lat: 6.6745, lng: -1.5716, at: Date.parse("2026-10-27T07:59:20+00:00"), accuracyM: 14 });
    expect(key).toBe(`${TRIP}:12`);

    expect(await res.json()).toEqual({
      geometry: snapped.geometry,
      confidence: 0.91,
      through_point_id: 12,
      points_used: 3,
      from_recorded_at: "2026-10-27T07:59:20+00:00",
      through_recorded_at: "2026-10-27T07:59:40+00:00",
    });
  });

  it("geometry null without calling the matcher when there are fewer than two fixes", async () => {
    setup({ id: TRIP, service_date: "2026-10-27" }, [fixesDesc[0]]);
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      geometry: null,
      confidence: 0,
      through_point_id: 12,
      points_used: 1,
      from_recorded_at: "2026-10-27T07:59:40+00:00",
      through_recorded_at: "2026-10-27T07:59:40+00:00",
    });
    expect(matchTrace).not.toHaveBeenCalled();
  });

  it("answers 200 with geometry null when the router is down", async () => {
    matchTrace.mockResolvedValue(null);
    setup({ id: TRIP, service_date: "2026-10-27" });
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ geometry: null, confidence: 0, through_point_id: 12, points_used: 3 });
  });
});
