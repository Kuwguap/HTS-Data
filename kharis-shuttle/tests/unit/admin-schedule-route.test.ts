/**
 * PATCH / DELETE /api/admin/schedule/:id — schedule edits reach the trips already
 * materialised from that row: upcoming bookingless trips are deleted (the tick
 * re-creates them with the new values), trips with bookings are kept and counted,
 * and a label-only change (or re-saving the same values) touches no trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, filterOf, type FakeCall, type FakeResult } from "./fake-admin";

vi.mock("server-only", () => ({}));

const { createAdminClient, requireRole } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/auth/require", () => ({ requireRole }));

import { DELETE, PATCH } from "@/app/api/admin/schedule/[id]/route";

const NOW = Date.parse("2026-10-27T08:00:00Z");
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SCHEDULE_ID = "22222222-0000-4000-8000-000000000001";
const T_FREE = "77777777-0000-4000-8000-000000000001"; // no booking rows
const T_BOOKED = "77777777-0000-4000-8000-000000000002"; // has a (cancelled) booking row
const ctx = { params: Promise.resolve({ id: SCHEDULE_ID }) };

const before = {
  id: SCHEDULE_ID,
  direction: "to_campus",
  depart_time: "07:30:00",
  days_of_week: [1, 2, 3, 4, 5],
  label: "Morning",
  seat_capacity: null,
  bookings_enabled: true,
  is_active: true,
  created_at: "2026-10-01T00:00:00Z",
};

function patch(body: Record<string, unknown>) {
  return new Request(`http://localhost:3100/api/admin/schedule/${SCHEDULE_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Scripted database: two upcoming trips, one of them with a booking row. */
function respond(call: FakeCall): FakeResult | undefined {
  if (call.table === "schedule_times" && call.op === "select") return { data: before, error: null };
  if (call.table === "schedule_times" && call.op === "update") return { data: { ...before, ...(call.payload as object) }, error: null };
  if (call.table === "schedule_times" && call.op === "delete") return { data: { id: SCHEDULE_ID }, error: null };
  if (call.table === "trips" && call.op === "select") return { data: [{ id: T_FREE }, { id: T_BOOKED }], error: null };
  if (call.table === "bookings" && call.op === "select") return { data: [{ trip_id: T_BOOKED }, { trip_id: T_BOOKED }], error: null };
  if (call.table === "trips" && call.op === "delete") {
    const ids = filterOf(call, "in", "id")?.args[1] as string[];
    return { data: ids.map((id) => ({ id })), error: null };
  }
  return undefined;
}

let db: ReturnType<typeof fakeAdmin>;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  requireRole.mockReset();
  requireRole.mockResolvedValue({ user: { id: ADMIN_ID }, profile: { id: ADMIN_ID, role: "admin", is_active: true } });
  db = fakeAdmin(respond);
  createAdminClient.mockReset();
  createAdminClient.mockReturnValue(db.client);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tripCalls = () => db.calls.filter((c) => c.table === "trips" || c.table === "bookings");

describe("PATCH /api/admin/schedule/:id", () => {
  it("deletes the bookingless upcoming trip, keeps and counts the booked one when the time changes", async () => {
    const res = await PATCH(patch({ depart_time: "08:00" }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule_time.depart_time).toBe("08:00");
    expect(body.deleted_trips).toBe(1);
    expect(body.kept_with_bookings).toBe(1);

    const ops = db.calls.map((c) => `${c.op}:${c.table}`);
    expect(ops).toEqual(["select:schedule_times", "update:schedule_times", "select:trips", "select:bookings", "delete:trips"]);

    const future = db.calls[2]!;
    expect(filterOf(future, "eq", "schedule_time_id")?.args[1]).toBe(SCHEDULE_ID);
    expect(filterOf(future, "eq", "status")?.args[1]).toBe("scheduled");
    expect(filterOf(future, "gt", "departure_at")?.args[1]).toBe(new Date(NOW).toISOString());

    expect(filterOf(db.calls[3]!, "in", "trip_id")?.args[1]).toEqual([T_FREE, T_BOOKED]);

    const del = db.calls[4]!;
    expect(filterOf(del, "in", "id")?.args[1]).toEqual([T_FREE]); // never the booked trip
    expect(filterOf(del, "eq", "confirmed_count")?.args[1]).toBe(0);
    expect(filterOf(del, "eq", "waitlist_count")?.args[1]).toBe(0);
  });

  it("propagates days, seats, bookings switch and pausing too", async () => {
    for (const body of [{ days_of_week: [1, 3, 5] }, { seat_capacity: 20 }, { bookings_enabled: false }, { is_active: false }]) {
      db = fakeAdmin(respond);
      createAdminClient.mockReturnValue(db.client);
      const res = await PATCH(patch(body), ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ deleted_trips: 1, kept_with_bookings: 1 });
      expect(tripCalls().map((c) => `${c.op}:${c.table}`)).toEqual(["select:trips", "select:bookings", "delete:trips"]);
    }
  });

  it("touches no trip for a label-only change", async () => {
    const res = await PATCH(patch({ label: "Early bird" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ schedule_time: { label: "Early bird" }, deleted_trips: 0, kept_with_bookings: 0 });
    expect(tripCalls()).toEqual([]);
  });

  it("touches no trip when the editor re-saves the same values (full payload)", async () => {
    const res = await PATCH(
      patch({ direction: "to_campus", depart_time: "07:30", days_of_week: [5, 4, 3, 2, 1], label: "Later label", seat_capacity: null, bookings_enabled: true, is_active: true }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted_trips: 0, kept_with_bookings: 0 });
    expect(tripCalls()).toEqual([]);
  });

  it("reports zero when there are no upcoming trips", async () => {
    db = fakeAdmin((call) => (call.table === "trips" && call.op === "select" ? { data: [], error: null } : respond(call)));
    createAdminClient.mockReturnValue(db.client);
    const res = await PATCH(patch({ depart_time: "09:00" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted_trips: 0, kept_with_bookings: 0 });
    expect(tripCalls().map((c) => `${c.op}:${c.table}`)).toEqual(["select:trips"]);
  });

  it("404s before touching trips when the departure does not exist", async () => {
    db = fakeAdmin((call) => (call.table === "schedule_times" ? { data: null, error: null } : respond(call)));
    createAdminClient.mockReturnValue(db.client);
    const res = await PATCH(patch({ depart_time: "09:00" }), ctx);
    expect(res.status).toBe(404);
    expect(tripCalls()).toEqual([]);
  });
});

describe("DELETE /api/admin/schedule/:id", () => {
  it("collects the upcoming trips first, deletes the row, then removes only the bookingless trips", async () => {
    const res = await DELETE(new Request("http://localhost:3100/x", { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: SCHEDULE_ID, deleted_trips: 1, kept_with_bookings: 1 });
    expect(db.calls.map((c) => `${c.op}:${c.table}`)).toEqual(["select:trips", "delete:schedule_times", "select:bookings", "delete:trips"]);
    expect(filterOf(db.calls[3]!, "in", "id")?.args[1]).toEqual([T_FREE]);
  });

  it("deletes no trip when the departure was already gone", async () => {
    db = fakeAdmin((call) => (call.table === "schedule_times" && call.op === "delete" ? { data: null, error: null } : respond(call)));
    createAdminClient.mockReturnValue(db.client);
    const res = await DELETE(new Request("http://localhost:3100/x", { method: "DELETE" }), ctx);
    expect(res.status).toBe(404);
    expect(db.calls.map((c) => `${c.op}:${c.table}`)).toEqual(["select:trips", "delete:schedule_times"]);
  });
});
