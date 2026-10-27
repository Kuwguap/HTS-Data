import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Booking, Database, Notification, PickupLocation, PickupRequest, Trip } from "@/lib/db.types";
import { getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, localDateString } from "@/lib/time";

/**
 * Server loaders for the student screens. Every function runs with the service
 * role, so call them only after requirePageAuth()/requireUser() decided who is
 * asking, and always scope by that user's id. All of them degrade to empty
 * results when the database is unreachable (never throw on read errors).
 */

type Admin = SupabaseClient<Database>;

export type MyBooking = Booking & { pickup_location: PickupLocation | null };
export type StudentTrip = Trip & { my_booking: MyBooking | null };
export type BookingWithTrip = Booking & { trip: Trip; pickup_location: PickupLocation | null };
export type PickupRequestWithPlace = PickupRequest & { pickup_location: PickupLocation | null; trip: Trip | null };

/** A booking that still occupies (or waits for) a seat. */
function isLiveBooking(b: Pick<Booking, "status">): boolean {
  return b.status === "confirmed" || b.status === "waitlisted" || b.status === "boarded";
}

async function loadPickupLocationsById(admin: Admin, ids: Array<string | null | undefined>): Promise<Map<string, PickupLocation>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const map = new Map<string, PickupLocation>();
  if (unique.length === 0) return map;
  const { data } = await admin.from("pickup_locations").select("*").in("id", unique);
  for (const loc of data ?? []) map.set(loc.id, loc);
  return map;
}

/** Attach the student's own live booking (if any) to each trip. */
async function attachMyBookings(admin: Admin, trips: Trip[], userId: string): Promise<StudentTrip[]> {
  if (trips.length === 0) return [];
  const { data: bookings } = await admin
    .from("bookings")
    .select("*")
    .eq("user_id", userId)
    .in(
      "trip_id",
      trips.map((t) => t.id),
    );
  const byTrip = new Map<string, Booking>();
  for (const b of bookings ?? []) {
    // One row per (trip, user) is enforced by the DB; prefer a live one anyway.
    const existing = byTrip.get(b.trip_id);
    if (!existing || (!isLiveBooking(existing) && isLiveBooking(b))) byTrip.set(b.trip_id, b);
  }
  const locations = await loadPickupLocationsById(
    admin,
    [...byTrip.values()].map((b) => b.pickup_location_id),
  );
  return trips.map((trip) => {
    const b = byTrip.get(trip.id);
    return {
      ...trip,
      my_booking: b ? { ...b, pickup_location: b.pickup_location_id ? (locations.get(b.pickup_location_id) ?? null) : null } : null,
    };
  });
}

/**
 * Trips from local today up to today + `days` (default settings.booking_open_days_ahead),
 * ordered by departure, each with the student's own booking joined.
 */
export async function listTripsForStudent(userId: string, opts: { days?: number } = {}): Promise<StudentTrip[]> {
  const admin = createAdminClient();
  const settings = await getSettings();
  const days = Math.max(0, opts.days ?? settings.booking_open_days_ahead);
  const now = new Date();
  const from = localDateString(now, settings.timezone);
  const to = localDateString(addDays(now, days), settings.timezone);
  const { data } = await admin
    .from("trips")
    .select("*")
    .gte("service_date", from)
    .lte("service_date", to)
    .order("departure_at", { ascending: true });
  return attachMyBookings(admin, data ?? [], userId);
}

/** One trip with the student's booking, or null when it does not exist. */
export async function getTripForStudent(tripId: string, userId: string): Promise<StudentTrip | null> {
  const admin = createAdminClient();
  const { data: trip } = await admin.from("trips").select("*").eq("id", tripId).maybeSingle();
  if (!trip) return null;
  const [withBooking] = await attachMyBookings(admin, [trip], userId);
  return withBooking ?? null;
}

/**
 * The student's bookings with their trips. `past: true` keeps departures that
 * have already left (history, newest first); otherwise upcoming ones, soonest first.
 */
export async function listMyBookings(userId: string, opts: { past?: boolean; limit?: number } = {}): Promise<BookingWithTrip[]> {
  const admin = createAdminClient();
  const limit = opts.limit ?? 100;
  const { data: bookings } = await admin
    .from("bookings")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (!bookings || bookings.length === 0) return [];
  const tripIds = [...new Set(bookings.map((b) => b.trip_id))];
  const { data: trips } = await admin.from("trips").select("*").in("id", tripIds);
  const tripById = new Map((trips ?? []).map((t) => [t.id, t]));
  const locations = await loadPickupLocationsById(
    admin,
    bookings.map((b) => b.pickup_location_id),
  );
  const nowMs = Date.now();
  const rows: BookingWithTrip[] = [];
  for (const b of bookings) {
    const trip = tripById.get(b.trip_id);
    if (!trip) continue;
    const departed = new Date(trip.departure_at).getTime() < nowMs;
    const finished = trip.status === "arrived" || trip.status === "cancelled" || trip.status === "expired";
    const isPast = departed || finished;
    if (opts.past ? !isPast : isPast) continue;
    rows.push({ ...b, trip, pickup_location: b.pickup_location_id ? (locations.get(b.pickup_location_id) ?? null) : null });
  }
  rows.sort((a, b) => {
    const d = new Date(a.trip.departure_at).getTime() - new Date(b.trip.departure_at).getTime();
    return opts.past ? -d : d;
  });
  return rows.slice(0, limit);
}

async function attachRequestRelations(admin: Admin, requests: PickupRequest[]): Promise<PickupRequestWithPlace[]> {
  if (requests.length === 0) return [];
  const locations = await loadPickupLocationsById(
    admin,
    requests.map((r) => r.pickup_location_id),
  );
  const tripIds = [...new Set(requests.map((r) => r.trip_id).filter((id): id is string => Boolean(id)))];
  const tripById = new Map<string, Trip>();
  if (tripIds.length > 0) {
    const { data: trips } = await admin.from("trips").select("*").in("id", tripIds);
    for (const t of trips ?? []) tripById.set(t.id, t);
  }
  return requests.map((r) => ({
    ...r,
    pickup_location: r.pickup_location_id ? (locations.get(r.pickup_location_id) ?? null) : null,
    trip: r.trip_id ? (tripById.get(r.trip_id) ?? null) : null,
  }));
}

/** The student's pickup requests, newest first. */
export async function listMyPickupRequests(userId: string, opts: { limit?: number } = {}): Promise<PickupRequestWithPlace[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("pickup_requests")
    .select("*")
    .eq("rider_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 20);
  return attachRequestRelations(admin, data ?? []);
}

/** One pickup request by id, only when it belongs to the student (null otherwise). */
export async function getMyPickupRequest(requestId: string, userId: string): Promise<PickupRequestWithPlace | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("pickup_requests").select("*").eq("id", requestId).eq("rider_id", userId).maybeSingle();
  if (!data) return null;
  const [row] = await attachRequestRelations(admin, [data]);
  return row ?? null;
}

/** The student's most recent pending request, if any (one at a time). */
export async function getPendingPickupRequest(userId: string): Promise<PickupRequest | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("pickup_requests")
    .select("*")
    .eq("rider_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Inbox: the student's notifications, newest first. */
export async function listNotifications(userId: string, opts: { limit?: number } = {}): Promise<Notification[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);
  return data ?? [];
}

/** Number of unread inbox items (tab-bar badge). */
export async function unreadCount(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
  return count ?? 0;
}

/** Trips that are boarding or on the way today (any direction), soonest first. */
export async function liveTrips(): Promise<Trip[]> {
  const admin = createAdminClient();
  const settings = await getSettings();
  const today = localDateString(new Date(), settings.timezone);
  const { data } = await admin
    .from("trips")
    .select("*")
    .in("status", ["boarding", "departed"])
    .gte("service_date", today)
    .order("departure_at", { ascending: true });
  return data ?? [];
}

/** Today's trips a student may still book or request a pickup for. */
export async function listOpenTripsToday(): Promise<Trip[]> {
  const admin = createAdminClient();
  const settings = await getSettings();
  const now = new Date();
  const today = localDateString(now, settings.timezone);
  const { data } = await admin
    .from("trips")
    .select("*")
    .eq("service_date", today)
    .in("status", ["scheduled", "boarding", "departed"])
    .gte("departure_at", new Date(now.getTime() - 30 * 60_000).toISOString())
    .order("departure_at", { ascending: true });
  return data ?? [];
}
