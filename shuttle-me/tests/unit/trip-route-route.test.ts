/**
 * GET /api/trips/[id]/route — auth, the "nothing to route" answers, the happy path
 * with the OSRM client mocked, via parsing and the student visibility window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireUser, getSettings, getActivePickupLocations, routeVia } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
  getSettings: vi.fn(),
  getActivePickupLocations: vi.fn(),
  routeVia: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireUser, isStaff: (p: { role: string }) => p.role !== "student" }));
vi.mock("@/lib/data/settings", () => ({ getSettings, getActivePickupLocations }));
vi.mock("@/lib/routing/osrm", () => ({ routeVia }));

import { GET } from "@/app/api/trips/[id]/route/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const STUDENT = "55555555-0000-4000-8000-000000000001";
const TRIP = "33333333-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TRIP }) };
const request = (query = "") => new Request(`http://localhost:3100/api/trips/${TRIP}/route${query}`);

const FROM = { lat: 6.6745, lng: -1.5716 };
const CAMPUS = { lat: 6.669, lng: -1.565 };
const KSB = { id: "11111111-0000-4000-8000-000000000003", name: "KSB", direction: "to_hostel", lat: 6.6692, lng: -1.5648, is_active: true, sort_order: 0 };

const settings = (over: Record<string, unknown> = {}) => ({
  timezone: "Africa/Accra",
  hostel_lat: null,
  hostel_lng: null,
  campus_lat: CAMPUS.lat,
  campus_lng: CAMPUS.lng,
  ...over,
});

const osrm = {
  geometry: [FROM, { lat: 6.672, lng: -1.569 }, CAMPUS],
  distanceM: 1470.2,
  durationS: 255.1,
  legs: [{ distanceM: 1470.2, durationS: 255.1 }],
};

let db: ReturnType<typeof fakeAdmin>;

function setup(trip: Record<string, unknown> | null) {
  const respond = (call: FakeCall): FakeResult | undefined => {
    if (call.table === "trips") return { data: trip, error: null };
    return undefined;
  };
  db = fakeAdmin(respond);
  createAdminClient.mockReturnValue(db.client);
}

const tripRow = (over: Record<string, unknown> = {}) => ({
  id: TRIP,
  direction: "to_campus",
  status: "departed",
  service_date: "2026-10-27",
  last_lat: FROM.lat,
  last_lng: FROM.lng,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  requireUser.mockReset();
  requireUser.mockResolvedValue({ user: { id: STUDENT }, profile: { id: STUDENT, role: "student", is_active: true } });
  getSettings.mockReset();
  getSettings.mockResolvedValue(settings());
  getActivePickupLocations.mockReset();
  getActivePickupLocations.mockResolvedValue([KSB]);
  routeVia.mockReset();
  routeVia.mockResolvedValue(osrm);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/trips/[id]/route", () => {
  it("401 when signed out", async () => {
    requireUser.mockRejectedValueOnce(new ApiError(401, "UNAUTHENTICATED", "Please log in."));
    setup(tripRow());
    const res = await GET(request(), ctx);
    expect(res.status).toBe(401);
    expect(routeVia).not.toHaveBeenCalled();
  });

  it("404 for an unknown trip id or a trip outside the student window", async () => {
    setup(null);
    expect((await GET(request(), ctx)).status).toBe(404);
    setup(tripRow({ service_date: "2026-10-20" }));
    expect((await GET(request(), ctx)).status).toBe(404);
    // staff see everything
    requireUser.mockResolvedValue({ user: { id: "d" }, profile: { id: "d", role: "driver", is_active: true } });
    setup(tripRow({ service_date: "2026-10-20" }));
    expect((await GET(request(), ctx)).status).toBe(200);
  });

  it("route null / no_position when the bus has not shared a fix yet", async () => {
    setup(tripRow({ last_lat: null, last_lng: null }));
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: null, reason: "no_position" });
    expect(res.headers.get("cache-control")).toBe("private, max-age=20");
    expect(routeVia).not.toHaveBeenCalled();
  });

  it("route null / no_destination when neither settings nor pickup points say where the trip ends", async () => {
    getSettings.mockResolvedValue(settings({ campus_lat: null, campus_lng: null }));
    getActivePickupLocations.mockResolvedValue([]);
    setup(tripRow());
    const res = await GET(request(), ctx);
    expect(await res.json()).toEqual({ route: null, reason: "no_destination" });
    expect(routeVia).not.toHaveBeenCalled();
  });

  it("routes from the bus to the destination and returns the snake_case shape", async () => {
    setup(tripRow());
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=20");
    expect(routeVia).toHaveBeenCalledWith([FROM, CAMPUS]);
    const body = await res.json();
    expect(body).toEqual({
      route: { geometry: osrm.geometry, distance_m: 1470.2, duration_s: 255.1, legs: [{ distance_m: 1470.2, duration_s: 255.1 }] },
      destination: CAMPUS,
      from: FROM,
      computed_at: new Date(NOW).toISOString(),
    });
    const select = db.calls.find((c) => c.table === "trips")!;
    expect(filterOf(select, "eq", "id")?.args[1]).toBe(TRIP);
  });

  it("falls back to the first to_hostel pickup point as the campus destination", async () => {
    getSettings.mockResolvedValue(settings({ campus_lat: null, campus_lng: null }));
    setup(tripRow());
    const res = await GET(request(), ctx);
    expect((await res.json()).destination).toEqual({ lat: KSB.lat, lng: KSB.lng });
    expect(routeVia).toHaveBeenCalledWith([FROM, { lat: KSB.lat, lng: KSB.lng }]);
  });

  it("threads a valid via point between from and to", async () => {
    setup(tripRow());
    const res = await GET(request("?via=6.672,-1.569"), ctx);
    expect(res.status).toBe(200);
    expect(routeVia).toHaveBeenCalledWith([FROM, { lat: 6.672, lng: -1.569 }, CAMPUS]);
  });

  it("400 for a malformed or out-of-range via", async () => {
    for (const via of ["abc", "6.67", "6.67,-1.57,0", "95,-1.57", "6.67,-181", "6.67,"]) {
      setup(tripRow());
      const res = await GET(request(`?via=${via}`), ctx);
      expect(res.status, via).toBe(400);
      expect((await res.json()).error.details.fieldErrors.via[0]).toMatch(/via=lat,lng/);
    }
    expect(routeVia).not.toHaveBeenCalled();
  });

  it("answers 200 with route null when the router is down", async () => {
    routeVia.mockResolvedValue(null);
    setup(tripRow());
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.route).toBeNull();
    expect(body.reason).toBe("router_unavailable");
    expect(body.destination).toEqual(CAMPUS);
    expect(body.from).toEqual(FROM);
  });
});
