/**
 * POST /api/driver/trips/[id]/status — trip-progress fan-out:
 * - boarding  → trip_boarding per pickup group (confirmed riders only, {pickup} = their stop),
 * - departed  → trip_departed to confirmed + boarded (url …/map); to_hostel trips also tell
 *               every active student with reminders on who has no booking (prefix …:all),
 * - arrived   → trip_arrived to boarded riders,
 * - unchanged status → nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireRole, requireTripAccess, notifyAndDrain, enqueueNotification, scheduleDrain, listActiveStudentIds } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireRole: vi.fn(),
  requireTripAccess: vi.fn(),
  notifyAndDrain: vi.fn(),
  enqueueNotification: vi.fn(),
  scheduleDrain: vi.fn(),
  listActiveStudentIds: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireRole }));
vi.mock("@/lib/data/driver", () => ({ requireTripAccess }));
vi.mock("@/lib/notify/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/enqueue")>();
  return { ...actual, notifyAndDrain, enqueueNotification, scheduleDrain, listActiveStudentIds };
});
vi.mock("@/lib/data/settings", () => ({
  getSettings: vi.fn(async () => ({ timezone: "Africa/Accra", hostel_name: "Kharis Courts Hostel", fare_pesewas: 1000, currency: "GHS" })),
}));

import { POST } from "@/app/api/driver/trips/[id]/status/route";

const DRIVER = "dddddddd-0000-4000-8000-000000000001";
const TRIP = "77777777-0000-4000-8000-000000000001";
const U1 = "55555555-0000-4000-8000-000000000001";
const U2 = "55555555-0000-4000-8000-000000000002";
const U3 = "55555555-0000-4000-8000-000000000003";
const U4 = "55555555-0000-4000-8000-000000000004";
const U5 = "55555555-0000-4000-8000-000000000005";
const GATE = "11111111-0000-4000-8000-000000000001";
const CARPARK = "11111111-0000-4000-8000-000000000002";
const ctx = { params: Promise.resolve({ id: TRIP }) };

function trip(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIP,
    status: "scheduled",
    direction: "to_campus",
    departure_at: "2026-10-27T07:30:00Z",
    origin_label: "Kharis Courts Hostel",
    destination_label: "KNUST",
    driver_id: DRIVER,
    ...overrides,
  };
}

const riders = [
  { user_id: U1, status: "confirmed", pickup_location_id: GATE },
  { user_id: U2, status: "confirmed", pickup_location_id: CARPARK },
  { user_id: U3, status: "boarded", pickup_location_id: GATE },
  { user_id: U4, status: "waitlisted", pickup_location_id: GATE },
  { user_id: U5, status: "confirmed", pickup_location_id: null },
];

function post(status: string) {
  return new Request(`http://localhost:3100/api/driver/trips/${TRIP}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

let db: ReturnType<typeof fakeAdmin>;

function setup(before: Record<string, unknown>, after: Record<string, unknown>) {
  const respond = (call: FakeCall): FakeResult | undefined => {
    if (call.table === "bookings") return { data: riders, error: null };
    if (call.table === "pickup_locations") {
      const ids = filterOf(call, "in", "id")?.args[1] as string[];
      return { data: [{ id: GATE, name: "Hostel main gate" }, { id: CARPARK, name: "Hostel car park" }].filter((p) => ids.includes(p.id)), error: null };
    }
    return undefined;
  };
  db = fakeAdmin(respond, async (name) => ({ data: name === "set_trip_status" ? after : null, error: null }));
  createAdminClient.mockReturnValue(db.client);
  requireTripAccess.mockResolvedValue({ trip: before, claimable: false });
}

beforeEach(() => {
  requireRole.mockReset();
  requireRole.mockResolvedValue({ user: { id: DRIVER }, profile: { id: DRIVER, role: "driver", is_active: true } });
  requireTripAccess.mockReset();
  notifyAndDrain.mockReset();
  notifyAndDrain.mockResolvedValue(1);
  enqueueNotification.mockReset();
  enqueueNotification.mockImplementation(async (_admin: unknown, input: { userIds: string[] }) => input.userIds.length);
  scheduleDrain.mockReset();
  scheduleDrain.mockResolvedValue(null);
  listActiveStudentIds.mockReset();
  listActiveStudentIds.mockResolvedValue([]);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const vars = { time: expect.any(String), origin: "Kharis Courts Hostel", destination: "KNUST", hostel: "Kharis Courts Hostel", trip_id: TRIP };

describe("boarding", () => {
  it("sends trip_boarding to confirmed riders grouped by pickup, one prefix per trip", async () => {
    setup(trip({ status: "scheduled" }), trip({ status: "boarding" }));
    const res = await POST(post("boarding"), ctx);
    expect(res.status).toBe(200);
    expect(notifyAndDrain).not.toHaveBeenCalled();
    const inputs = enqueueNotification.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(inputs).toHaveLength(3);
    for (const i of inputs) {
      expect(i).toMatchObject({ kind: "trip_boarding", url: `/app/trips/${TRIP}`, dedupePrefix: `boarding:${TRIP}`, urgency: "high", collapseTag: `trip:${TRIP}`, ttlSeconds: 900 });
    }
    const byUser = new Map(inputs.flatMap((i) => (i.userIds as string[]).map((u) => [u, i.vars as Record<string, unknown>])));
    expect([...byUser.keys()].sort()).toEqual([U1, U2, U5].sort()); // boarded + waitlisted riders are not told
    expect(byUser.get(U1)).toEqual({ ...vars, pickup: "Hostel main gate" });
    expect(byUser.get(U2)).toEqual({ ...vars, pickup: "Hostel car park" });
    expect(byUser.get(U5)).toEqual({ ...vars, pickup: "Kharis Courts Hostel" }); // no pickup chosen → origin
    expect(scheduleDrain).toHaveBeenCalledTimes(1);
  });
});

describe("departed", () => {
  it("to_campus: trip_departed to confirmed + boarded riders only, opening the live map", async () => {
    setup(trip({ status: "boarding" }), trip({ status: "departed" }));
    const res = await POST(post("departed"), ctx);
    expect(res.status).toBe(200);
    expect(listActiveStudentIds).not.toHaveBeenCalled();
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification.mock.calls[0]![1]).toMatchObject({
      kind: "trip_departed",
      userIds: [U1, U2, U3, U5],
      url: `/app/trips/${TRIP}/map`,
      dedupePrefix: `departed:${TRIP}`,
      vars,
    });
    expect(scheduleDrain).toHaveBeenCalledTimes(1);
  });

  it("to_hostel: also tells every active student with reminders on who has no booking on the trip (prefix …:all)", async () => {
    const OTHER = "55555555-0000-4000-8000-000000000099";
    listActiveStudentIds.mockResolvedValue([U1, U3, U4, OTHER]);
    setup(trip({ status: "boarding", direction: "to_hostel", origin_label: "KSB", destination_label: "Kharis Courts Hostel" }), trip({ status: "departed", direction: "to_hostel", origin_label: "KSB", destination_label: "Kharis Courts Hostel" }));
    const res = await POST(post("departed"), ctx);
    expect(res.status).toBe(200);
    expect(listActiveStudentIds).toHaveBeenCalledWith(db.client, { remindersOnly: true });
    const inputs = enqueueNotification.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ kind: "trip_departed", userIds: [U1, U2, U3, U5], dedupePrefix: `departed:${TRIP}` });
    // U1/U3/U4 have bookings (any status) → excluded; only the stranger is told
    expect(inputs[1]).toMatchObject({ kind: "trip_departed", userIds: [OTHER], dedupePrefix: `departed:${TRIP}:all`, url: `/app/trips/${TRIP}/map` });
    expect(scheduleDrain).toHaveBeenCalledTimes(1);
  });
});

describe("arrived", () => {
  it("sends trip_arrived to boarded riders", async () => {
    setup(trip({ status: "departed" }), trip({ status: "arrived" }));
    const res = await POST(post("arrived"), ctx);
    expect(res.status).toBe(200);
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(notifyAndDrain).toHaveBeenCalledTimes(1);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({
      kind: "trip_arrived",
      userIds: [U3],
      url: `/app/trips/${TRIP}`,
      dedupePrefix: `arrived:${TRIP}`,
      urgency: "high",
      vars,
    });
  });
});

describe("no change", () => {
  it("sends nothing when the trip was already in the requested status", async () => {
    setup(trip({ status: "departed" }), trip({ status: "departed" }));
    const res = await POST(post("departed"), ctx);
    expect(res.status).toBe(200);
    expect(db.calls.filter((c) => c.table === "bookings")).toHaveLength(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(notifyAndDrain).not.toHaveBeenCalled();
    expect(scheduleDrain).not.toHaveBeenCalled();
  });
});
