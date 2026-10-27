import "server-only";

/**
 * Server loaders for the admin console. Every loader degrades to empty data when
 * the database is unreachable (no throw), so the pages always render.
 */
import type {
  Booking,
  MessageTemplate,
  PickupLocation,
  Profile,
  ScheduleTime,
  TickRun,
  Trip,
  TripDirection,
  TripStatus,
  UserRole,
} from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, formatTime, isoWeekday, localDateString, secondsSince } from "@/lib/time";
import { TEMPLATE_DEFAULTS, TEMPLATE_KINDS } from "./template-defaults";
import { getSettings } from "./settings";

/** Run a query, returning `fallback` on any error (logged). */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[admin] ${label} failed:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** Seconds without a tick before the overview shows the red warning. */
export const TICK_STALE_SECONDS = 5 * 60;

/** Appended to tick_runs.note by POST /api/admin/tick ("Run tick now"). */
export const MANUAL_TICK_NOTE = "manual";

export function isManualTick(run: Pick<TickRun, "note">): boolean {
  return (run.note ?? "").includes(MANUAL_TICK_NOTE);
}

export type TickHealth = {
  /** Last automatic (cron) run; falls back to any run when none is recorded. */
  last: TickRun | null;
  ageSeconds: number | null;
  ok: boolean;
  recent: TickRun[];
};

/** Derive health from `recent` (newest first): a hand-run tick must not hide a dead cron. */
export function deriveTickHealth(recent: TickRun[], now = new Date()): TickHealth {
  const last = recent.find((r) => !isManualTick(r)) ?? recent[0] ?? null;
  const ageSeconds = secondsSince(last?.ran_at, now);
  return { last, ageSeconds, ok: ageSeconds != null && ageSeconds <= TICK_STALE_SECONDS, recent };
}

export async function tickHealth(limit = 20, now = new Date()): Promise<TickHealth> {
  const admin = createAdminClient();
  const recent = await safe(
    "tick_runs",
    async () => {
      const { data, error } = await admin.from("tick_runs").select("*").order("id", { ascending: false }).limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    [] as TickRun[],
  );
  return deriveTickHealth(recent, now);
}

export type Overview = {
  today: string;
  students: number;
  drivers: number;
  tripsToday: TripWithDriver[];
  bookingsToday: number;
  pendingRequests: number;
  pushFailures24h: number;
  tick: TickHealth;
};

export type TripWithDriver = Trip & { driver_name: string | null };

async function countRows(label: string, build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  return safe(
    label,
    async () => {
      const { count, error } = await build();
      if (error) throw error;
      return count ?? 0;
    },
    0,
  );
}

async function attachDrivers(trips: Trip[]): Promise<TripWithDriver[]> {
  const ids = [...new Set(trips.map((t) => t.driver_id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return trips.map((t) => ({ ...t, driver_name: null }));
  const admin = createAdminClient();
  const drivers = await safe(
    "drivers",
    async () => {
      const { data, error } = await admin.from("profiles").select("id, full_name").in("id", ids);
      if (error) throw error;
      return data ?? [];
    },
    [] as Array<Pick<Profile, "id" | "full_name">>,
  );
  const names = new Map(drivers.map((d) => [d.id, d.full_name]));
  return trips.map((t) => ({ ...t, driver_name: t.driver_id ? (names.get(t.driver_id) ?? null) : null }));
}

export async function overview(now = new Date()): Promise<Overview> {
  const settings = await getSettings();
  const admin = createAdminClient();
  const today = localDateString(now, settings.timezone);
  const since24h = new Date(now.getTime() - 24 * 3600_000).toISOString();

  const [students, drivers, trips, pendingRequests, pushFailures24h, tick] = await Promise.all([
    countRows("count students", () => admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student").eq("is_active", true)),
    countRows("count drivers", () => admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "driver").eq("is_active", true)),
    listTrips({ from: today, to: today }),
    countRows("count requests", () => admin.from("pickup_requests").select("id", { count: "exact", head: true }).eq("status", "pending")),
    countRows("count push failures", () =>
      admin.from("notifications").select("id", { count: "exact", head: true }).eq("push_status", "failed").gte("created_at", since24h),
    ),
    tickHealth(5, now),
  ]);

  const tripIds = trips.map((t) => t.id);
  const bookingsToday =
    tripIds.length === 0
      ? 0
      : await countRows("count bookings", () =>
          admin.from("bookings").select("id", { count: "exact", head: true }).in("trip_id", tripIds).in("status", ["confirmed", "waitlisted", "boarded"]),
        );

  return { today, students, drivers, tripsToday: trips, bookingsToday, pendingRequests, pushFailures24h, tick };
}

export async function listSchedule(): Promise<ScheduleTime[]> {
  const admin = createAdminClient();
  return safe(
    "schedule",
    async () => {
      const { data, error } = await admin.from("schedule_times").select("*").order("direction").order("depart_time");
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}

export async function listLocations(): Promise<PickupLocation[]> {
  const admin = createAdminClient();
  return safe(
    "locations",
    async () => {
      const { data, error } = await admin.from("pickup_locations").select("*").order("sort_order").order("name");
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}

export async function listDaysOff(): Promise<Array<{ service_date: string; reason: string | null }>> {
  const admin = createAdminClient();
  return safe(
    "days off",
    async () => {
      const { data, error } = await admin.from("service_days_off").select("*").order("service_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}

export type UserFilter = UserRole | "deactivated" | "all";

/**
 * Make a search term safe inside a PostgREST `or=(…)` filter: the reserved characters
 * `, . : ( ) " \` (and the LIKE wildcard `%`) become spaces. `_` is kept: usernames contain
 * it, and as a one-character wildcard it can only widen the match.
 */
export function sanitizeSearchTerm(q: string | null | undefined): string {
  return (q ?? "")
    .replace(/[,.:()"\\%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function listUsers(opts: { q?: string | null; role?: UserFilter | null; limit?: number } = {}): Promise<Profile[]> {
  const admin = createAdminClient();
  return safe(
    "users",
    async () => {
      let query = admin.from("profiles").select("*").order("full_name").limit(opts.limit ?? 1000);
      const term = sanitizeSearchTerm(opts.q);
      if (term) {
        const pattern = `%${term}%`;
        query = query.or(["username", "full_name", "room", "phone"].map((col) => `${col}.ilike.${pattern}`).join(","));
      }
      if (opts.role === "deactivated") query = query.eq("is_active", false);
      else if (opts.role && opts.role !== "all") query = query.eq("role", opts.role);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}

/** Active drivers (and admins, who may drive) for assignment pickers. */
export async function listDrivers(): Promise<Array<Pick<Profile, "id" | "full_name" | "role" | "phone">>> {
  const admin = createAdminClient();
  return safe(
    "drivers",
    async () => {
      const { data, error } = await admin
        .from("profiles")
        .select("id, full_name, role, phone")
        .in("role", ["driver", "admin"])
        .eq("is_active", true)
        .order("role", { ascending: false })
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}

/** Trips by service_date (inclusive range), earliest first, with the driver's name. */
export async function listTrips(opts: { from: string; to: string }): Promise<TripWithDriver[]> {
  const admin = createAdminClient();
  const trips = await safe(
    "trips",
    async () => {
      const { data, error } = await admin
        .from("trips")
        .select("*")
        .gte("service_date", opts.from)
        .lte("service_date", opts.to)
        .order("departure_at")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
    [] as Trip[],
  );
  return attachDrivers(trips);
}

export type BookingWithRider = Booking & {
  rider: Pick<Profile, "id" | "full_name" | "username" | "phone" | "room"> | null;
  pickup_name: string | null;
};

export type TripAdminData = {
  trip: TripWithDriver;
  bookings: BookingWithRider[];
};

export async function getTripAdmin(id: string): Promise<TripAdminData | null> {
  const admin = createAdminClient();
  // The trip and its bookings both key off `id` alone: fetch them in one round trip.
  const [trip, bookings] = await Promise.all([
    safe(
      "trip",
      async () => {
        const { data, error } = await admin.from("trips").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        return data;
      },
      null as Trip | null,
    ),
    safe(
      "trip bookings",
      async () => {
        const { data, error } = await admin.from("bookings").select("*").eq("trip_id", id).order("created_at");
        if (error) throw error;
        return data ?? [];
      },
      [] as Booking[],
    ),
  ]);
  if (!trip) return null;

  const riderIds = [...new Set(bookings.map((b) => b.user_id))];
  const pickupIds = [...new Set(bookings.map((b) => b.pickup_location_id).filter((x): x is string => Boolean(x)))];
  const [riders, pickups, [withDriver]] = await Promise.all([
    riderIds.length
      ? safe(
          "riders",
          async () => {
            const { data, error } = await admin.from("profiles").select("id, full_name, username, phone, room").in("id", riderIds);
            if (error) throw error;
            return data ?? [];
          },
          [] as Array<Pick<Profile, "id" | "full_name" | "username" | "phone" | "room">>,
        )
      : Promise.resolve([]),
    pickupIds.length
      ? safe(
          "pickups",
          async () => {
            const { data, error } = await admin.from("pickup_locations").select("id, name").in("id", pickupIds);
            if (error) throw error;
            return data ?? [];
          },
          [] as Array<Pick<PickupLocation, "id" | "name">>,
        )
      : Promise.resolve([]),
    attachDrivers([trip]),
  ]);
  const riderMap = new Map(riders.map((r) => [r.id, r]));
  const pickupMap = new Map(pickups.map((p) => [p.id, p.name]));
  return {
    trip: withDriver ?? { ...trip, driver_name: null },
    bookings: bookings.map((b) => ({
      ...b,
      rider: riderMap.get(b.user_id) ?? null,
      pickup_name: b.pickup_location_id ? (pickupMap.get(b.pickup_location_id) ?? null) : null,
    })),
  };
}

/** Every notification kind, with the stored template or the seed default. */
export async function listTemplates(): Promise<Array<MessageTemplate & { is_default: boolean }>> {
  const admin = createAdminClient();
  const stored = await safe(
    "templates",
    async () => {
      const { data, error } = await admin.from("message_templates").select("*");
      if (error) throw error;
      return data ?? [];
    },
    [] as MessageTemplate[],
  );
  const byKey = new Map(stored.map((t) => [t.key, t]));
  return TEMPLATE_KINDS.map((key) => {
    const row = byKey.get(key);
    const def = TEMPLATE_DEFAULTS[key];
    if (!row) return { key, title: def.title, body: def.body, updated_at: "", is_default: true };
    return { ...row, is_default: row.title === def.title && row.body === def.body };
  });
}

export type ReportRow = { label: string; rides: number; capacity: number; trips: number; noShows: number; missed: number };
export type PickupReportRow = { label: string; count: number };
export type TripReportRow = {
  id: string;
  service_date: string;
  time: string;
  direction: TripDirection;
  status: TripStatus;
  rides: number;
  /** Confirmed seats on a trip that expired (nobody ran it in the app): not rides. */
  missed: number;
  capacity: number;
  fillPct: number;
};

export type Report = {
  from: string;
  to: string;
  totals: { rides: number; trips: number; capacity: number; fillPct: number; noShows: number; noShowPct: number; waitlisted: number; missed: number };
  perDay: ReportRow[];
  perDeparture: ReportRow[];
  perPickup: PickupReportRow[];
  perTrip: TripReportRow[];
};

type ReportTrip = Pick<Trip, "id" | "service_date" | "departure_at" | "direction" | "status" | "seat_capacity">;
type ReportBooking = Pick<Booking, "id" | "trip_id" | "status" | "pickup_location_id">;

/** A trip still ahead of `now` has not carried anyone yet: it stays out of the report. */
export function isPendingTrip(trip: Pick<Trip, "status" | "departure_at">, now: Date): boolean {
  return (trip.status === "scheduled" || trip.status === "boarding") && Date.parse(trip.departure_at) > now.getTime();
}

/** Pure aggregation behind reports() (unit-tested without a database). */
export function buildReport(
  opts: { from: string; to: string; timeZone: string; now?: Date },
  trips: ReportTrip[],
  bookings: ReportBooking[],
  locName: Map<string, string>,
): Report {
  const now = opts.now ?? new Date();
  const counted = trips.filter((t) => t.status !== "cancelled" && !isPendingTrip(t, now));
  const countedIds = new Set(counted.map((t) => t.id));
  const expired = new Set(counted.filter((t) => t.status === "expired").map((t) => t.id));

  const byTrip = new Map<string, { rides: number; noShows: number; waitlisted: number; missed: number }>();
  const perPickupMap = new Map<string, number>();
  for (const b of bookings) {
    if (!countedIds.has(b.trip_id)) continue;
    const agg = byTrip.get(b.trip_id) ?? { rides: 0, noShows: 0, waitlisted: 0, missed: 0 };
    const rode = b.status === "boarded" || (b.status === "confirmed" && !expired.has(b.trip_id));
    if (rode) {
      agg.rides++;
      const key = b.pickup_location_id ? (locName.get(b.pickup_location_id) ?? "Unknown pickup") : "No pickup chosen";
      perPickupMap.set(key, (perPickupMap.get(key) ?? 0) + 1);
    } else if (b.status === "confirmed") agg.missed++;
    else if (b.status === "no_show") agg.noShows++;
    else if (b.status === "waitlisted") agg.waitlisted++;
    byTrip.set(b.trip_id, agg);
  }

  const bump = (map: Map<string, ReportRow>, label: string, rides: number, capacity: number, noShows: number, missed: number) => {
    const row = map.get(label) ?? { label, rides: 0, capacity: 0, trips: 0, noShows: 0, missed: 0 };
    row.rides += rides;
    row.capacity += capacity;
    row.trips += 1;
    row.noShows += noShows;
    row.missed += missed;
    map.set(label, row);
  };

  const perDayMap = new Map<string, ReportRow>();
  const perDepMap = new Map<string, ReportRow>();
  const totals = { rides: 0, trips: 0, capacity: 0, noShows: 0, waitlisted: 0, missed: 0 };
  const perTrip: TripReportRow[] = [];
  for (const t of counted) {
    const agg = byTrip.get(t.id) ?? { rides: 0, noShows: 0, waitlisted: 0, missed: 0 };
    const time = formatTime(t.departure_at, opts.timeZone);
    const dep = `${time} · ${t.direction === "to_campus" ? "To campus" : "To hostel"}`;
    bump(perDayMap, t.service_date, agg.rides, t.seat_capacity, agg.noShows, agg.missed);
    bump(perDepMap, dep, agg.rides, t.seat_capacity, agg.noShows, agg.missed);
    totals.rides += agg.rides;
    totals.trips += 1;
    totals.capacity += t.seat_capacity;
    totals.noShows += agg.noShows;
    totals.waitlisted += agg.waitlisted;
    totals.missed += agg.missed;
    perTrip.push({
      id: t.id,
      service_date: t.service_date,
      time,
      direction: t.direction,
      status: t.status,
      rides: agg.rides,
      missed: agg.missed,
      capacity: t.seat_capacity,
      fillPct: t.seat_capacity ? Math.round((agg.rides / t.seat_capacity) * 100) : 0,
    });
  }
  const fillPct = totals.capacity ? Math.round((totals.rides / totals.capacity) * 100) : 0;
  const noShowBase = totals.rides + totals.noShows;
  const noShowPct = noShowBase ? Math.round((totals.noShows / noShowBase) * 100) : 0;

  return {
    from: opts.from,
    to: opts.to,
    totals: { ...totals, fillPct, noShowPct },
    perDay: [...perDayMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
    perDeparture: [...perDepMap.values()],
    perPickup: [...perPickupMap.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    perTrip,
  };
}

/** Default range: the current week (Mon..today). */
export function defaultReportRange(now = new Date(), timeZone?: string): { from: string; to: string } {
  const today = localDateString(now, timeZone);
  const weekday = isoWeekday(now, timeZone) - 1; // Mon=0
  const from = localDateString(addDays(now, -weekday), timeZone);
  return { from, to: today };
}

export async function reports(opts: { from: string; to: string }, now = new Date()): Promise<Report> {
  const admin = createAdminClient();
  // Settings, the trips in range and the pickup names do not depend on each other.
  const [settings, trips, locations] = await Promise.all([
    getSettings(),
    safe(
      "report trips",
      async () => {
        const { data, error } = await admin
          .from("trips")
          .select("*")
          .gte("service_date", opts.from)
          .lte("service_date", opts.to)
          .neq("status", "cancelled")
          .order("departure_at")
          .limit(2000);
        if (error) throw error;
        return data ?? [];
      },
      [] as Trip[],
    ),
    listLocations(),
  ]);
  const tripIds = trips.map((t) => t.id);
  const bookings = tripIds.length
    ? await safe(
        "report bookings",
        async () => {
          const { data, error } = await admin
            .from("bookings")
            .select("id, trip_id, status, pickup_location_id")
            .in("trip_id", tripIds)
            .limit(20000);
          if (error) throw error;
          return data ?? [];
        },
        [] as ReportBooking[],
      )
    : [];
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  return buildReport({ from: opts.from, to: opts.to, timeZone: settings.timezone, now }, trips, bookings, locName);
}

/**
 * One CSV cell: quoted when it holds a quote, comma or line break; text starting with
 * `= + - @` gets a leading apostrophe so a spreadsheet never runs it as a formula.
 */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of a report (one block per section). */
export function reportToCsv(r: Report): string {
  const esc = csvCell;
  const lines: string[] = [];
  lines.push(`Report,${r.from},${r.to}`);
  lines.push("");
  lines.push("Totals,rides,trips,capacity,fill_pct,no_shows,no_show_pct,waitlisted,missed");
  lines.push(["", r.totals.rides, r.totals.trips, r.totals.capacity, r.totals.fillPct, r.totals.noShows, r.totals.noShowPct, r.totals.waitlisted, r.totals.missed].map(esc).join(","));
  lines.push("");
  lines.push("Per day,date,rides,trips,capacity,no_shows,missed");
  for (const row of r.perDay) lines.push(["", row.label, row.rides, row.trips, row.capacity, row.noShows, row.missed].map(esc).join(","));
  lines.push("");
  lines.push("Per departure,departure,rides,trips,capacity,no_shows,missed");
  for (const row of r.perDeparture) lines.push(["", row.label, row.rides, row.trips, row.capacity, row.noShows, row.missed].map(esc).join(","));
  lines.push("");
  lines.push("Per pickup,pickup,rides");
  for (const row of r.perPickup) lines.push(["", row.label, row.count].map(esc).join(","));
  lines.push("");
  lines.push("Per trip,trip_id,date,time,direction,status,rides,missed,capacity,fill_pct");
  for (const row of r.perTrip) lines.push(["", row.id, row.service_date, row.time, row.direction, row.status, row.rides, row.missed, row.capacity, row.fillPct].map(esc).join(","));
  return lines.join("\n") + "\n";
}
