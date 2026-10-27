/**
 * trip_approaching: riders within 400 m of the newest fix (confirmed only, once per
 * booking), and the location route hooking it in after a successful insert without
 * ever breaking the 204.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireRole, requireTripAccess, enqueueNotification, scheduleDrain } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireRole: vi.fn(),
  requireTripAccess: vi.fn(),
  enqueueNotification: vi.fn(),
  scheduleDrain: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireRole }));
vi.mock("@/lib/data/driver", () => ({ requireTripAccess }));
vi.mock("@/lib/notify/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/enqueue")>();
  return { ...actual, enqueueNotification, scheduleDrain };
});
vi.mock("@/lib/data/settings", () => ({
  getSettings: vi.fn(async () => ({ timezone: "Africa/Accra", hostel_name: "Kharis Courts Hostel" })),
}));

import { APPROACH_RADIUS_M, approachDedupePrefix, approachMinutes, approachingRiders, notifyApproaching, type WaitingRider } from "@/lib/notify/approaching";
import { POST } from "@/app/api/driver/location/route";

const DRIVER = "dddddddd-0000-4000-8000-000000000001";
const TRIP = "77777777-0000-4000-8000-000000000001";
const B1 = "88888888-0000-4000-8000-000000000001";
const B2 = "88888888-0000-4000-8000-000000000002";
const B3 = "88888888-0000-4000-8000-000000000003";
const B4 = "88888888-0000-4000-8000-000000000004";
const U1 = "55555555-0000-4000-8000-000000000001";
const U2 = "55555555-0000-4000-8000-000000000002";
const U3 = "55555555-0000-4000-8000-000000000003";
const U4 = "55555555-0000-4000-8000-000000000004";

// Hostel main gate; ~0.001° latitude ≈ 111 m.
const GATE = { id: "11111111-0000-4000-8000-000000000001", name: "Hostel main gate", lat: 6.6745, lng: -1.5716 };
const KSB = { id: "11111111-0000-4000-8000-000000000003", name: "KSB", lat: 6.6690, lng: -1.5670 }; // ~0.8 km away
const BUS_NEAR_GATE = { lat: 6.6765, lng: -1.5716 }; // ≈ 222 m north of the gate

const riders: WaitingRider[] = [
  { booking_id: B1, user_id: U1, status: "confirmed", pickup: GATE },
  { booking_id: B2, user_id: U2, status: "boarded", pickup: GATE },
  { booking_id: B3, user_id: U3, status: "confirmed", pickup: KSB },
  { booking_id: B4, user_id: U4, status: "confirmed", pickup: null },
];

describe("approachingRiders", () => {
  it("keeps confirmed riders inside the radius, drops boarded ones, far pickups and riders without a pickup", () => {
    const hits = approachingRiders(BUS_NEAR_GATE, riders);
    expect(hits.map((h) => h.booking_id)).toEqual([B1]);
    expect(hits[0]!.distance_m).toBeGreaterThan(200);
    expect(hits[0]!.distance_m).toBeLessThan(250);
    expect(hits[0]!.minutes).toBe(1);
    expect(hits[0]!.pickup_name).toBe("Hostel main gate");
  });

  it("uses the radius boundary and sorts nearest first", () => {
    const farBus = { lat: 6.6745 + 0.0045, lng: -1.5716 }; // ≈ 500 m: outside 400 m, inside a 600 m test radius
    expect(approachingRiders(farBus, riders)).toEqual([]);
    expect(approachingRiders(farBus, riders, 600).map((h) => h.booking_id)).toEqual([B1]);
    expect(APPROACH_RADIUS_M).toBe(400);
    const both = approachingRiders({ lat: 6.672, lng: -1.5695 }, riders, 5_000);
    expect(both.map((h) => h.booking_id)).toEqual([B1, B3]);
    expect(both[0]!.distance_m).toBeLessThanOrEqual(both[1]!.distance_m);
  });

  it("estimates minutes at ~23 km/h, never below 1", () => {
    expect(approachMinutes(0)).toBe(1);
    expect(approachMinutes(380)).toBe(1);
    expect(approachMinutes(1_150)).toBe(3);
    expect(approachDedupePrefix(TRIP, B1)).toBe(`approach:${TRIP}:${B1}`);
  });
});

function bookingRows(call: FakeCall): FakeResult {
  expect(call.op).toBe("select");
  expect(filterOf(call, "eq", "trip_id")?.args[1]).toBe(TRIP);
  expect(filterOf(call, "eq", "status")?.args[1]).toBe("confirmed");
  // the DB already filtered boarded riders out; a stale row is still ignored by the pure check
  return {
    data: [
      { id: B1, user_id: U1, status: "confirmed", pickup_locations: GATE },
      { id: B3, user_id: U3, status: "confirmed", pickup_locations: KSB },
      { id: B2, user_id: U2, status: "boarded", pickup_locations: GATE },
    ],
    error: null,
  };
}

beforeEach(() => {
  enqueueNotification.mockReset();
  enqueueNotification.mockImplementation(async (_admin: unknown, input: { userIds: string[] }) => input.userIds.length);
  scheduleDrain.mockReset();
  scheduleDrain.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyApproaching", () => {
  it("enqueues trip_approaching once per nearby booking with the approach:<trip>:<booking> prefix and drains once", async () => {
    const db = fakeAdmin((call) => (call.table === "bookings" ? bookingRows(call) : undefined));
    const n = await notifyApproaching(db.client as never, { id: TRIP }, BUS_NEAR_GATE, { time: "7:30 AM", destination: "KNUST" });
    expect(n).toBe(1);
    expect(db.calls).toHaveLength(1);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification.mock.calls[0]![1]).toEqual({
      userIds: [U1],
      kind: "trip_approaching",
      vars: { time: "7:30 AM", destination: "KNUST", count: 1, pickup: "Hostel main gate", trip_id: TRIP },
      url: `/app/trips/${TRIP}/map`,
      dedupePrefix: `approach:${TRIP}:${B1}`,
      ttlSeconds: 600,
      urgency: "high",
      collapseTag: `trip:${TRIP}`,
    });
    expect(scheduleDrain).toHaveBeenCalledTimes(1);
  });

  it("returns 0 and never throws when the select or the enqueue fails", async () => {
    const broken = fakeAdmin(() => ({ data: null, error: { message: "boom" } }));
    expect(await notifyApproaching(broken.client as never, { id: TRIP }, BUS_NEAR_GATE)).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
    enqueueNotification.mockRejectedValue(new Error("rpc down"));
    const db = fakeAdmin((call) => (call.table === "bookings" ? bookingRows(call) : undefined));
    expect(await notifyApproaching(db.client as never, { id: TRIP }, BUS_NEAR_GATE)).toBe(0);
    expect(scheduleDrain).not.toHaveBeenCalled();
  });
});

describe("POST /api/driver/location → approaching", () => {
  const trip = { id: TRIP, status: "departed", direction: "to_campus", departure_at: "2026-10-27T07:30:00Z", origin_label: "Kharis Courts Hostel", destination_label: "KNUST", driver_id: DRIVER };

  const ctx = { params: Promise.resolve({}) };

  function post(points: Array<{ lat: number; lng: number; at: string }>) {
    return new Request("http://localhost:3100/api/driver/location", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trip_id: TRIP, points }),
    });
  }

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T07:40:00Z"));
    requireRole.mockReset();
    requireRole.mockResolvedValue({ user: { id: DRIVER }, profile: { id: DRIVER, role: "driver", is_active: true } });
    requireTripAccess.mockReset();
    requireTripAccess.mockResolvedValue({ trip, claimable: false });
    createAdminClient.mockReset();
  });

  it("stores the batch, then checks riders against the NEWEST point and still answers 204 when the push fails", async () => {
    const db = fakeAdmin((call) => (call.table === "bookings" ? bookingRows(call) : undefined));
    createAdminClient.mockReturnValue(db.client);
    enqueueNotification.mockRejectedValue(new Error("rpc down"));
    const res = await POST(
      post([
        { lat: KSB.lat, lng: KSB.lng, at: "2026-10-27T07:39:50Z" }, // older, near KSB
        { lat: BUS_NEAR_GATE.lat, lng: BUS_NEAR_GATE.lng, at: "2026-10-27T07:39:58Z" }, // newest, near the gate
      ]),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(db.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["trip_locations:insert", "bookings:select"]);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification.mock.calls[0]![1]).toMatchObject({ userIds: [U1], kind: "trip_approaching", dedupePrefix: `approach:${TRIP}:${B1}`, vars: { pickup: "Hostel main gate", time: expect.any(String), destination: "KNUST" } });
  });

  it("does not run the check when nothing was inserted (all points dropped as clock nonsense)", async () => {
    const db = fakeAdmin(() => undefined);
    createAdminClient.mockReturnValue(db.client);
    const res = await POST(post([{ lat: GATE.lat, lng: GATE.lng, at: "2026-10-20T07:39:58Z" }]), ctx);
    expect(res.status).toBe(204);
    expect(db.calls).toHaveLength(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});
