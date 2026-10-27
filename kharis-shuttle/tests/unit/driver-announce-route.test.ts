/**
 * POST /api/driver/announce — the return_announcement IS the trip's reminder: the route
 * stamps trips.reminder_sent_at right after create_adhoc_trip so run_tick's reminder loop
 * (0005) never pushes trip_reminder for the same trip a second time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireRole, notifyAndDrain, listActiveStudentIds } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireRole: vi.fn(),
  notifyAndDrain: vi.fn(),
  listActiveStudentIds: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireRole }));
vi.mock("@/lib/notify/enqueue", () => ({ notifyAndDrain, listActiveStudentIds }));
vi.mock("@/lib/data/settings", () => ({
  getSettings: vi.fn(async () => ({
    hostel_name: "Kharis Courts Hostel",
    campus_name: "KNUST",
    timezone: "Africa/Accra",
    fare_pesewas: 1000,
    currency: "GHS",
    default_seat_capacity: 14,
    reminder_lead_minutes: 60,
  })),
}));

import { POST } from "@/app/api/driver/announce/route";

const NOW = Date.parse("2026-10-27T15:00:00Z");
const DRIVER = "dddddddd-0000-4000-8000-000000000001";
const TRIP = "77777777-0000-4000-8000-000000000009";
const ctx = { params: Promise.resolve({}) };

function post(body: Record<string, unknown>) {
  return new Request("http://localhost:3100/api/driver/announce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "to_hostel", origin_label: "KSB", ...body }),
  });
}

function tripRow(departureAt: string, reminderAt: string | null) {
  return {
    id: TRIP,
    direction: "to_hostel",
    status: reminderAt ? "scheduled" : "boarding",
    origin_label: "KSB",
    destination_label: "Kharis Courts Hostel",
    departure_at: departureAt,
    seat_capacity: 14,
    reminder_at: reminderAt,
    reminder_sent_at: null,
  };
}

let db: ReturnType<typeof fakeAdmin>;

function setup(reminderAt: string | null) {
  const respond = (call: FakeCall): FakeResult | undefined => {
    if (call.table === "trips" && call.op === "update") {
      return { data: { ...tripRow(new Date(NOW + 90 * 60_000).toISOString(), reminderAt), ...(call.payload as object) }, error: null };
    }
    return undefined;
  };
  db = fakeAdmin(respond, async (name, args) => {
    if (name === "create_adhoc_trip") return { data: tripRow(args.p_departure_at as string, reminderAt), error: null };
    if (name === "set_trip_status") return { data: { ...tripRow(args.p_trip_id as string, reminderAt), status: "boarding" }, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  createAdminClient.mockReturnValue(db.client);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  requireRole.mockReset();
  requireRole.mockResolvedValue({ user: { id: DRIVER }, profile: { id: DRIVER, role: "driver", is_active: true } });
  notifyAndDrain.mockReset();
  notifyAndDrain.mockResolvedValue(3);
  listActiveStudentIds.mockReset();
  listActiveStudentIds.mockResolvedValue(["55555555-0000-4000-8000-000000000001"]);
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/driver/announce", () => {
  it("stamps reminder_sent_at when create_adhoc_trip scheduled a tick reminder, before pushing the announcement", async () => {
    const reminderAt = new Date(NOW + 30 * 60_000).toISOString();
    setup(reminderAt);
    const res = await POST(post({ leaving_in_minutes: 90 }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.trip.reminder_sent_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.trip.reminder_sent_at))).toBe(false);

    const update = db.calls.find((c) => c.table === "trips" && c.op === "update");
    expect(update).toBeDefined();
    expect(update!.payload).toEqual({ reminder_sent_at: body.trip.reminder_sent_at });
    expect(filterOf(update!, "eq", "id")?.args[1]).toBe(TRIP);
    expect(filterOf(update!, "is", "reminder_sent_at")?.args[1]).toBeNull();

    expect(notifyAndDrain).toHaveBeenCalledTimes(1);
    expect(notifyAndDrain.mock.calls[0]![1]).toMatchObject({ kind: "return_announcement", dedupePrefix: `announce:${TRIP}` });
    expect(listActiveStudentIds).toHaveBeenCalledWith(db.client, { remindersOnly: false });
  });

  it("leaves the trip alone when no reminder was scheduled (lead already passed)", async () => {
    setup(null);
    const res = await POST(post({ leaving_in_minutes: 10 }), ctx);
    expect(res.status).toBe(200);
    expect(db.calls.filter((c) => c.table === "trips")).toEqual([]);
    expect(db.rpc.mock.calls.map((c) => c[0])).toEqual(["create_adhoc_trip"]); // already boarding: no set_trip_status
    expect(notifyAndDrain).toHaveBeenCalledTimes(1);
  });
});
