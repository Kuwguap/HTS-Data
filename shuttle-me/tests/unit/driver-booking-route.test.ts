/**
 * POST /api/driver/trips/[id]/bookings/[bookingId]
 * - cancelling an already cancelled booking is a no-op (no cancel_booking, no push),
 * - booking_promoted carries the promotion stamp in its dedupe prefix (book_seat re-uses
 *   a rider's cancelled / no_show row, so the same id can be promoted again later).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireRole, requireTripAccess, notifyAndDrain } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireRole: vi.fn(),
  requireTripAccess: vi.fn(),
  notifyAndDrain: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireRole }));
vi.mock("@/lib/data/driver", () => ({ requireTripAccess }));
vi.mock("@/lib/notify/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/enqueue")>();
  return { ...actual, notifyAndDrain };
});
vi.mock("@/lib/data/settings", () => ({
  getSettings: vi.fn(async () => ({ timezone: "Africa/Accra", fare_pesewas: 1000, currency: "GHS" })),
}));

import { POST } from "@/app/api/driver/trips/[id]/bookings/[bookingId]/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const DRIVER = "dddddddd-0000-4000-8000-000000000001";
const TRIP = "77777777-0000-4000-8000-000000000001";
const B1 = "88888888-0000-4000-8000-000000000001";
const B2 = "88888888-0000-4000-8000-000000000002";
const U1 = "55555555-0000-4000-8000-000000000001";
const U2 = "55555555-0000-4000-8000-000000000002";
const PROMOTED_AT = "2026-10-27T08:00:05.000Z";
const ctx = { params: Promise.resolve({ id: TRIP, bookingId: B1 }) };

const trip = { id: TRIP, departure_at: "2026-10-27T09:30:00Z", destination_label: "KNUST", origin_label: "Kharis Courts Hostel", driver_id: DRIVER };

function booking(overrides: Record<string, unknown> = {}) {
  return { id: B1, trip_id: TRIP, user_id: U1, status: "confirmed", pickup_location_id: null, promoted_at: null, cancelled_at: null, ...overrides };
}

function post(status: string) {
  return new Request(`http://localhost:3100/api/driver/trips/${TRIP}/bookings/${B1}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

let db: ReturnType<typeof fakeAdmin>;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;

function setup(existing: Record<string, unknown>, rpcResults: Record<string, unknown>) {
  const respond = (call: FakeCall): FakeResult | undefined => {
    if (call.table === "bookings" && call.op === "select") return { data: existing, error: null };
    if (call.table === "pickup_locations") return { data: { name: "Hostel main gate" }, error: null };
    return undefined;
  };
  db = fakeAdmin(respond, async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: rpcResults[name] ?? null, error: null };
  });
  createAdminClient.mockReturnValue(db.client);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  rpcCalls = [];
  requireRole.mockReset();
  requireRole.mockResolvedValue({ user: { id: DRIVER }, profile: { id: DRIVER, role: "driver", is_active: true } });
  requireTripAccess.mockReset();
  requireTripAccess.mockResolvedValue({ trip, claimable: false });
  notifyAndDrain.mockReset();
  notifyAndDrain.mockResolvedValue(1);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("status: cancelled", () => {
  it("returns the row untouched when the booking is already cancelled (no cancel_booking, no push)", async () => {
    const existing = booking({ status: "cancelled", cancelled_at: "2026-10-27T07:00:00Z" });
    setup(existing, {});
    const res = await POST(post("cancelled"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ booking: existing, promoted: null });
    expect(rpcCalls).toEqual([]);
    expect(notifyAndDrain).not.toHaveBeenCalled();
  });

  it("cancels an active booking and stamps the promoted rider's dedupe prefix with promoted_at", async () => {
    const cancelled = booking({ status: "cancelled", cancelled_at: "2026-10-27T08:00:00Z" });
    const promoted = booking({ id: B2, user_id: U2, status: "confirmed", promoted_at: PROMOTED_AT });
    setup(booking(), { cancel_booking: { cancelled, promoted } });
    const res = await POST(post("cancelled"), ctx);
    expect(res.status).toBe(200);
    expect(rpcCalls.map((c) => c.name)).toEqual(["cancel_booking"]);
    expect(notifyAndDrain).toHaveBeenCalledTimes(2);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({ kind: "booking_cancelled", userIds: [U1], dedupePrefix: `booking_cancelled:${B1}:${NOW}` });
    expect(notifyAndDrain.mock.calls[1]![1]).toMatchObject({
      kind: "booking_promoted",
      userIds: [U2],
      dedupePrefix: `booking:${B2}:promoted:${Date.parse(PROMOTED_AT)}`,
    });
  });
});

describe("status: no_show", () => {
  it("promotes the waitlist and stamps each booking_promoted prefix with promoted_at (Date.now() fallback)", async () => {
    const promotedA = booking({ id: B2, user_id: U2, status: "confirmed", promoted_at: PROMOTED_AT });
    const promotedB = booking({ id: "88888888-0000-4000-8000-000000000003", user_id: "55555555-0000-4000-8000-000000000003", status: "confirmed", promoted_at: null });
    setup(booking(), { set_booking_status: booking({ status: "no_show" }), promote_waitlist: [promotedA, promotedB] });
    const res = await POST(post("no_show"), ctx);
    expect(res.status).toBe(200);
    expect(rpcCalls.map((c) => c.name)).toEqual(["set_booking_status", "promote_waitlist"]);
    expect(notifyAndDrain).toHaveBeenCalledTimes(2);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({
      kind: "booking_promoted",
      userIds: [U2],
      dedupePrefix: `booking:${B2}:promoted:${Date.parse(PROMOTED_AT)}`,
    });
    expect(notifyAndDrain.mock.calls[1]![1]).toMatchObject({ dedupePrefix: `booking:${promotedB.id}:promoted:${NOW}` });
  });

  it("a second promotion of the same re-used row gets a different prefix", async () => {
    const { promotedDedupePrefix } = await import("@/lib/notify/enqueue");
    const first = promotedDedupePrefix({ id: B2, promoted_at: "2026-10-27T08:00:00Z" });
    const second = promotedDedupePrefix({ id: B2, promoted_at: "2026-10-27T08:30:00Z" });
    expect(first).not.toBe(second);
    expect(first).toBe(`booking:${B2}:promoted:${Date.parse("2026-10-27T08:00:00Z")}`);
    // Same shape as the student cancel route (src/app/api/bookings/[id]/cancel/route.ts).
    expect(promotedDedupePrefix({ id: B2, promoted_at: null })).toBe(`booking:${B2}:promoted:${NOW}`);
  });
});
