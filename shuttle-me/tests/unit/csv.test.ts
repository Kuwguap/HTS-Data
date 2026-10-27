import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/data/settings", () => ({ getSettings: async () => ({}) }));

import { buildReport, csvCell, deriveTickHealth, isPendingTrip, reportToCsv, sanitizeSearchTerm, type Report } from "@/lib/data/admin";
import type { TickRun } from "@/lib/db.types";

describe("csvCell", () => {
  it("passes plain values through", () => {
    expect(csvCell("Gate A")).toBe("Gate A");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(-5)).toBe("-5");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("cr\rbreak")).toBe('"cr\rbreak"');
  });

  it("neutralises spreadsheet formulas in text cells", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
});

const report: Report = {
  from: "2026-10-20",
  to: "2026-10-26",
  totals: { rides: 3, trips: 2, capacity: 28, fillPct: 11, noShows: 1, noShowPct: 25, waitlisted: 0, missed: 2 },
  perDay: [{ label: "2026-10-20", rides: 3, capacity: 28, trips: 2, noShows: 1, missed: 2 }],
  perDeparture: [{ label: "7:30 AM · To campus", rides: 3, capacity: 28, trips: 2, noShows: 1, missed: 2 }],
  perPickup: [{ label: "=Gate, A", count: 3 }],
  perTrip: [{ id: "t1", service_date: "2026-10-20", time: "7:30 AM", direction: "to_campus", status: "arrived", rides: 3, missed: 0, capacity: 14, fillPct: 21 }],
};

describe("reportToCsv", () => {
  it("writes one block per section with escaped cells", () => {
    const csv = reportToCsv(report);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Report,2026-10-20,2026-10-26");
    expect(csv).toContain("Totals,rides,trips,capacity,fill_pct,no_shows,no_show_pct,waitlisted,missed\n,3,2,28,11,1,25,0,2\n");
    expect(csv).toContain(`,"'=Gate, A",3\n`);
    expect(csv).toContain("Per trip,trip_id,date,time,direction,status,rides,missed,capacity,fill_pct\n,t1,2026-10-20,7:30 AM,to_campus,arrived,3,0,14,21\n");
    expect(csv.endsWith("\n")).toBe(true);
  });
});

describe("sanitizeSearchTerm", () => {
  it("strips PostgREST reserved characters and LIKE wildcards but keeps underscores", () => {
    expect(sanitizeSearchTerm('ama,full_name.eq."x"\\(y):z%')).toBe("ama full_name eq x y z");
    expect(sanitizeSearchTerm("  ama   mensah ")).toBe("ama mensah");
    expect(sanitizeSearchTerm(null)).toBe("");
  });
});

describe("buildReport", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const tz = "Africa/Accra";
  const trips = [
    { id: "past", service_date: "2026-10-26", departure_at: "2026-10-26T07:30:00Z", direction: "to_campus" as const, status: "arrived" as const, seat_capacity: 14 },
    { id: "expired", service_date: "2026-10-26", departure_at: "2026-10-26T09:30:00Z", direction: "to_campus" as const, status: "expired" as const, seat_capacity: 14 },
    { id: "future", service_date: "2026-10-26", departure_at: "2026-10-26T15:30:00Z", direction: "to_hostel" as const, status: "scheduled" as const, seat_capacity: 14 },
    { id: "cancelled", service_date: "2026-10-26", departure_at: "2026-10-26T13:30:00Z", direction: "to_hostel" as const, status: "cancelled" as const, seat_capacity: 14 },
  ];
  const bookings = [
    { id: "b1", trip_id: "past", status: "boarded" as const, pickup_location_id: "gate" },
    { id: "b2", trip_id: "past", status: "confirmed" as const, pickup_location_id: null },
    { id: "b3", trip_id: "past", status: "no_show" as const, pickup_location_id: "gate" },
    { id: "b4", trip_id: "expired", status: "confirmed" as const, pickup_location_id: "gate" },
    { id: "b5", trip_id: "expired", status: "boarded" as const, pickup_location_id: "gate" },
    { id: "b6", trip_id: "future", status: "confirmed" as const, pickup_location_id: "gate" },
  ];
  const r = buildReport({ from: "2026-10-26", to: "2026-10-26", timeZone: tz, now }, trips, bookings, new Map([["gate", "Gate A"]]));

  it("leaves future and cancelled trips out of capacity and the per-trip list", () => {
    expect(r.perTrip.map((t) => t.id)).toEqual(["past", "expired"]);
    expect(r.totals.trips).toBe(2);
    expect(r.totals.capacity).toBe(28);
  });

  it("counts never-boarded confirmed seats on expired trips as missed, not rides", () => {
    expect(r.totals.rides).toBe(3); // b1, b2, b5
    expect(r.totals.missed).toBe(1); // b4
    expect(r.totals.noShows).toBe(1);
    expect(r.perTrip.find((t) => t.id === "expired")).toMatchObject({ status: "expired", rides: 1, missed: 1 });
    expect(r.perPickup).toEqual([{ label: "Gate A", count: 2 }, { label: "No pickup chosen", count: 1 }]);
  });

  it("isPendingTrip only flags scheduled/boarding trips still ahead", () => {
    expect(isPendingTrip({ status: "scheduled", departure_at: "2026-10-26T15:30:00Z" }, now)).toBe(true);
    expect(isPendingTrip({ status: "scheduled", departure_at: "2026-10-26T11:30:00Z" }, now)).toBe(false);
    expect(isPendingTrip({ status: "expired", departure_at: "2026-10-26T15:30:00Z" }, now)).toBe(false);
  });
});

describe("deriveTickHealth", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const run = (id: number, minutesAgo: number, note: string | null): TickRun => ({
    id,
    ran_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    now_ts: now.toISOString(),
    trips_created: 0,
    daily_enqueued: 0,
    reminders_enqueued: 0,
    nudges_enqueued: 0,
    manifests_enqueued: 0,
    expired_trips: 0,
    expired_requests: 0,
    pushes_sent: 0,
    pushes_failed: 0,
    duration_ms: 1,
    note,
  });

  it("ignores manual runs when the cron is dead", () => {
    const h = deriveTickHealth([run(3, 1, "manual"), run(2, 2, "cleanup:2026-10-26 manual"), run(1, 30, null)], now);
    expect(h.last?.id).toBe(1);
    expect(h.ok).toBe(false);
  });

  it("is healthy on a fresh automatic run", () => {
    const h = deriveTickHealth([run(2, 1, "cleanup:2026-10-26"), run(1, 2, "manual")], now);
    expect(h.last?.id).toBe(2);
    expect(h.ok).toBe(true);
  });

  it("falls back to a manual run when nothing else exists", () => {
    const h = deriveTickHealth([run(1, 1, "manual")], now);
    expect(h.last?.id).toBe(1);
    expect(h.ok).toBe(true);
    expect(deriveTickHealth([], now)).toMatchObject({ last: null, ageSeconds: null, ok: false });
  });
});
