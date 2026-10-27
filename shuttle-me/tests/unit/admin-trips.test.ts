/**
 * POST /api/admin/trips — the departure must not be in the past (mirrors the PATCH guard).
 * Auth, settings, data loaders and the Supabase admin client are stubbed; only the route
 * handler's own validation and its create_adhoc_trip call are exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { rpc, tripUpdates, createAdminClient, requireRole, notifyAndDrain, listActiveStudentIds } = vi.hoisted(() => {
  const rpc = vi.fn();
  /** `from("trips").update(...)...maybeSingle()` calls, in order. */
  const tripUpdates: Array<{ table: string; patch: Record<string, unknown>; filters: unknown[][] }> = [];
  const from = (table: string) => {
    const rec = { table, patch: {} as Record<string, unknown>, filters: [] as unknown[][] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      update: (patch: Record<string, unknown>) => ((rec.patch = patch), api),
      select: () => api,
      eq: (...args: unknown[]) => (rec.filters.push(["eq", ...args]), api),
      is: (...args: unknown[]) => (rec.filters.push(["is", ...args]), api),
      maybeSingle: async () => {
        tripUpdates.push(rec);
        return { data: null, error: null };
      },
    };
    return api;
  };
  return {
    rpc,
    tripUpdates,
    createAdminClient: vi.fn(() => ({ rpc, from })),
    requireRole: vi.fn(),
    notifyAndDrain: vi.fn(),
    listActiveStudentIds: vi.fn(),
  };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireRole }));
vi.mock("@/lib/notify/enqueue", () => ({ notifyAndDrain, listActiveStudentIds }));
vi.mock("@/lib/data/admin", () => ({ listTrips: vi.fn(async () => []) }));
vi.mock("@/lib/data/settings", () => ({
  getSettings: vi.fn(async () => ({
    id: 1,
    hostel_name: "Kharis Courts Hostel",
    campus_name: "KNUST",
    timezone: "Africa/Accra",
    fare_pesewas: 1000,
    currency: "GHS",
    payment_note: "Cash only",
    enquiry_phone: null,
    default_seat_capacity: 14,
    reminder_lead_minutes: 30,
    nudge_minutes: 10,
    manifest_lead_minutes: 10,
    booking_cutoff_minutes: 5,
    booking_open_days_ahead: 1,
    daily_announcement_enabled: true,
    daily_announcement_time: "06:00",
    location_stale_seconds: 90,
    signup_code: null,
    default_driver_id: null,
  })),
}));

import { POST } from "@/app/api/admin/trips/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({}) };

function post(body: Record<string, unknown>) {
  return new Request("http://localhost:3100/api/admin/trips", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      direction: "to_campus",
      origin_label: "Kharis Courts Hostel",
      destination_label: "KNUST",
      ...body,
    }),
  });
}

function tripRow(departureAt: string) {
  return {
    id: "77777777-0000-4000-8000-000000000001",
    direction: "to_campus",
    origin_label: "Kharis Courts Hostel",
    destination_label: "KNUST",
    departure_at: departureAt,
    service_date: "2026-10-27",
    seat_capacity: 14,
    confirmed_count: 0,
    waitlist_count: 0,
    status: "scheduled",
    reminder_at: null,
    driver_id: null,
  };
}

beforeEach(() => {
  // The route reads the clock through both Date.now() and `new Date()`: fake the whole Date.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  tripUpdates.length = 0;
  requireRole.mockReset();
  requireRole.mockResolvedValue({
    user: { id: ADMIN_ID },
    profile: { id: ADMIN_ID, role: "admin", is_active: true },
  });
  createAdminClient.mockClear();
  rpc.mockReset();
  rpc.mockImplementation(async (_fn: string, args: { p_departure_at: string }) => ({ data: tripRow(args.p_departure_at), error: null }));
  notifyAndDrain.mockReset();
  notifyAndDrain.mockResolvedValue(0);
  listActiveStudentIds.mockReset();
  listActiveStudentIds.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/admin/trips", () => {
  it("rejects a departure in the past with a field error and never creates the trip", async () => {
    const anHourAgo = new Date(NOW - 60 * 60_000).toISOString();
    const res = await POST(post({ departure_at: anHourAgo }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toBe("Please check the form.");
    expect(body.error.details).toEqual({ fieldErrors: { departure_at: ["That time is in the past"] } });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(notifyAndDrain).not.toHaveBeenCalled();
  });

  it("rejects a departure just over the one-minute tolerance too", async () => {
    const res = await POST(post({ departure_at: new Date(NOW - 61_000).toISOString() }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.details.fieldErrors.departure_at).toEqual(["That time is in the past"]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts a departure a few seconds ago (clock skew) and one in the future", async () => {
    const skewed = new Date(NOW - 30_000).toISOString();
    const skewedRes = await POST(post({ departure_at: skewed }), ctx);
    expect(skewedRes.status).toBe(200);

    const inTwoHours = new Date(NOW + 2 * 60 * 60_000).toISOString();
    const res = await POST(post({ departure_at: inTwoHours, seat_capacity: 10 }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trip.departure_at).toBe(inTwoHours);
    expect(body.notified).toBe(0);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("create_adhoc_trip", {
      p_direction: "to_campus",
      p_origin: "Kharis Courts Hostel",
      p_destination: "KNUST",
      p_departure_at: inTwoHours,
      p_seat_capacity: 10,
      p_driver_id: null,
      p_created_by: ADMIN_ID,
    });
    expect(notifyAndDrain).not.toHaveBeenCalled(); // notify defaults to false
  });

  it("still runs the schema validation first (a malformed time is a plain VALIDATION error)", async () => {
    const res = await POST(post({ departure_at: "yesterday" }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION");
    expect(Object.keys(body.error.details.fieldErrors)).toEqual(["departure_at"]);
    expect(rpc).not.toHaveBeenCalled();
  });

  describe("notify: true and the tick's reminder", () => {
    const inTwoHours = new Date(NOW + 2 * 60 * 60_000).toISOString();
    const reminderAt = new Date(NOW + 90 * 60_000).toISOString(); // lead 30 min, as create_adhoc_trip would set

    it("to_hostel: the return_announcement replaces the reminder, so reminder_sent_at is stamped before the push", async () => {
      rpc.mockImplementation(async (_fn: string, args: { p_departure_at: string }) => ({
        data: { ...tripRow(args.p_departure_at), direction: "to_hostel", origin_label: "KSB", destination_label: "Kharis Courts Hostel", reminder_at: reminderAt, reminder_sent_at: null },
        error: null,
      }));
      listActiveStudentIds.mockResolvedValue([ADMIN_ID]);
      const res = await POST(post({ direction: "to_hostel", origin_label: "KSB", destination_label: "Kharis Courts Hostel", departure_at: inTwoHours, notify: true }), ctx);
      expect(res.status).toBe(200);

      expect(tripUpdates).toHaveLength(1);
      expect(tripUpdates[0]!.table).toBe("trips");
      expect(tripUpdates[0]!.patch).toEqual({ reminder_sent_at: expect.any(String) });
      expect(Number.isNaN(Date.parse(tripUpdates[0]!.patch.reminder_sent_at as string))).toBe(false);
      expect(tripUpdates[0]!.filters).toEqual([
        ["eq", "id", "77777777-0000-4000-8000-000000000001"],
        ["is", "reminder_sent_at", null],
      ]);
      expect(notifyAndDrain).toHaveBeenCalledTimes(1);
      expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({ kind: "return_announcement", dedupePrefix: "adhoc:77777777-0000-4000-8000-000000000001" });
      // the stamp happens before the push is enqueued
      expect(tripUpdates.length).toBe(1);
    });

    it("to_campus with the lead still ahead: re-uses the tick's reminder prefix and leaves reminder_sent_at alone", async () => {
      rpc.mockImplementation(async (_fn: string, args: { p_departure_at: string }) => ({
        data: { ...tripRow(args.p_departure_at), reminder_at: reminderAt, reminder_sent_at: null },
        error: null,
      }));
      listActiveStudentIds.mockResolvedValue([ADMIN_ID]);
      const res = await POST(post({ departure_at: inTwoHours, notify: true }), ctx);
      expect(res.status).toBe(200);
      expect(tripUpdates).toEqual([]);
      expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({
        kind: "trip_reminder",
        dedupePrefix: `reminder:77777777-0000-4000-8000-000000000001:${Math.round(Date.parse(inTwoHours) / 1000)}`,
      });
    });

    it("no reminder scheduled at all (reminder_at null): nothing to stamp", async () => {
      rpc.mockImplementation(async (_fn: string, args: { p_departure_at: string }) => ({
        data: { ...tripRow(args.p_departure_at), direction: "to_hostel", reminder_at: null, reminder_sent_at: null },
        error: null,
      }));
      const res = await POST(post({ direction: "to_hostel", departure_at: new Date(NOW + 20 * 60_000).toISOString(), notify: true }), ctx);
      expect(res.status).toBe(200);
      expect(tripUpdates).toEqual([]);
    });
  });

  it("requires an admin before reading the body", async () => {
    const { ApiError } = await import("@/lib/api");
    requireRole.mockRejectedValue(new ApiError(403, "FORBIDDEN", "You don't have access to this."));
    const res = await POST(post({ departure_at: new Date(NOW + 60 * 60_000).toISOString() }), ctx);
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
