import "server-only";

import { cache } from "react";
import { ApiError } from "@/lib/api";
import type { Booking, BookingStatus, PickupLocation, PickupRequest, Profile, Trip } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, localDateString } from "@/lib/time";
import { getSettings } from "./settings";

/** Every loader here degrades to empty data when the database is unreachable. */

export type RiderProfile = Pick<Profile, "id" | "full_name" | "username" | "room" | "phone">;

export type DriverTrip = Trip & {
  /** driver_id = the signed-in driver. */
  isMine: boolean;
  /** Nobody is assigned yet. */
  unassigned: boolean;
  boarded_count: number;
};

export type ManifestBooking = Booking & {
  rider: RiderProfile;
  pickup_name: string;
};

export type ManifestGroup = {
  id: string | null;
  name: string;
  /** confirmed + boarded + no_show at this pickup (waitlist shown separately). */
  riders: ManifestBooking[];
  confirmed: number;
  boarded: number;
  no_show: number;
};

export type RequestWithRider = PickupRequest & {
  rider: RiderProfile;
  pickup_name: string;
  trip: Pick<Trip, "id" | "departure_at" | "direction" | "status"> | null;
};

export type Manifest = {
  trip: Trip;
  groups: ManifestGroup[];
  waitlist: ManifestBooking[];
  acceptedRequests: RequestWithRider[];
  counts: { confirmed: number; waitlist: number; boarded: number; no_show: number };
};

const UNKNOWN_RIDER = (id: string): RiderProfile => ({ id, full_name: "Unknown rider", username: "", room: null, phone: null });

async function loadRiders(ids: string[]): Promise<Map<string, RiderProfile>> {
  const map = new Map<string, RiderProfile>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;
  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, full_name, username, room, phone").in("id", unique);
  for (const p of data ?? []) map.set(p.id, p);
  return map;
}

async function loadLocations(ids: Array<string | null | undefined>): Promise<Map<string, PickupLocation>> {
  const map = new Map<string, PickupLocation>();
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return map;
  const admin = createAdminClient();
  const { data } = await admin.from("pickup_locations").select("*").in("id", unique);
  for (const l of data ?? []) map.set(l.id, l);
  return map;
}

/** Today + tomorrow (local dates in settings.timezone). */
export async function driverDateRange(): Promise<{ from: string; to: string; today: string }> {
  const settings = await getSettings();
  const now = new Date();
  const today = localDateString(now, settings.timezone);
  return { from: today, to: localDateString(addDays(now, 1), settings.timezone), today };
}

/**
 * Trips for today and tomorrow, ordered by departure, with "is this mine" and the
 * boarded count. Drivers see every trip (an unassigned one can be claimed).
 */
export const listTripsForDriver = cache(async (driverId: string): Promise<DriverTrip[]> => {
  const admin = createAdminClient();
  const { from, to } = await driverDateRange();
  const { data: trips, error } = await admin
    .from("trips")
    .select("*")
    .gte("service_date", from)
    .lte("service_date", to)
    .order("departure_at", { ascending: true });
  if (error || !trips) return [];

  const ids = trips.map((t) => t.id);
  const boarded = new Map<string, number>();
  if (ids.length > 0) {
    const { data: rows } = await admin.from("bookings").select("trip_id").in("trip_id", ids).eq("status", "boarded");
    for (const r of rows ?? []) boarded.set(r.trip_id, (boarded.get(r.trip_id) ?? 0) + 1);
  }

  return trips.map((t) => ({
    ...t,
    isMine: t.driver_id === driverId,
    unassigned: t.driver_id === null,
    boarded_count: boarded.get(t.id) ?? 0,
  }));
});

export const getTrip = cache(async (tripId: string): Promise<Trip | null> => {
  const admin = createAdminClient();
  const { data } = await admin.from("trips").select("*").eq("id", tripId).maybeSingle();
  return data ?? null;
});

const STATUS_ORDER: Record<BookingStatus, number> = { confirmed: 0, boarded: 1, no_show: 2, waitlisted: 3, cancelled: 4 };

/**
 * Manifest for one trip: active bookings joined with the rider profile and pickup
 * name, grouped by pickup location (confirmed first, then boarded, then no-show),
 * the waitlist in position order, and accepted pickup requests for the trip.
 */
export const getManifest = cache(async (tripId: string): Promise<Manifest | null> => {
  const trip = await getTrip(tripId);
  if (!trip) return null;
  const admin = createAdminClient();

  const [{ data: bookings }, { data: requests }] = await Promise.all([
    admin
      .from("bookings")
      .select("*")
      .eq("trip_id", tripId)
      .in("status", ["confirmed", "waitlisted", "boarded", "no_show"])
      .order("created_at", { ascending: true }),
    admin.from("pickup_requests").select("*").eq("trip_id", tripId).eq("status", "accepted").order("created_at", { ascending: true }),
  ]);

  const bookingRows = bookings ?? [];
  const requestRows = requests ?? [];
  const [riders, locations] = await Promise.all([
    loadRiders([...bookingRows.map((b) => b.user_id), ...requestRows.map((r) => r.rider_id)]),
    loadLocations([...bookingRows.map((b) => b.pickup_location_id), ...requestRows.map((r) => r.pickup_location_id)]),
  ]);

  const decorate = (b: Booking): ManifestBooking => ({
    ...b,
    rider: riders.get(b.user_id) ?? UNKNOWN_RIDER(b.user_id),
    pickup_name: (b.pickup_location_id && locations.get(b.pickup_location_id)?.name) || "No pickup point",
  });

  const groupsById = new Map<string, ManifestGroup>();
  const waitlist: ManifestBooking[] = [];
  const counts = { confirmed: 0, waitlist: 0, boarded: 0, no_show: 0 };

  for (const raw of bookingRows) {
    const b = decorate(raw);
    if (b.status === "waitlisted") {
      waitlist.push(b);
      counts.waitlist += 1;
      continue;
    }
    if (b.status === "confirmed") counts.confirmed += 1;
    else if (b.status === "boarded") counts.boarded += 1;
    else if (b.status === "no_show") counts.no_show += 1;

    const key = b.pickup_location_id ?? "__none";
    let g = groupsById.get(key);
    if (!g) {
      g = { id: b.pickup_location_id, name: b.pickup_name, riders: [], confirmed: 0, boarded: 0, no_show: 0 };
      groupsById.set(key, g);
    }
    g.riders.push(b);
    if (b.status === "confirmed") g.confirmed += 1;
    else if (b.status === "boarded") g.boarded += 1;
    else if (b.status === "no_show") g.no_show += 1;
  }

  const sortOrder = (id: string | null) => (id ? (locations.get(id)?.sort_order ?? 9_999) : 10_000);
  const groups = [...groupsById.values()]
    .map((g) => ({
      ...g,
      riders: [...g.riders].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.rider.full_name.localeCompare(b.rider.full_name)),
    }))
    .sort((a, b) => sortOrder(a.id) - sortOrder(b.id) || a.name.localeCompare(b.name));

  waitlist.sort((a, b) => (a.waitlist_position ?? 999) - (b.waitlist_position ?? 999));

  const acceptedRequests: RequestWithRider[] = requestRows.map((r) => ({
    ...r,
    rider: riders.get(r.rider_id) ?? UNKNOWN_RIDER(r.rider_id),
    pickup_name: requestPlace(r, locations),
    trip: { id: trip.id, departure_at: trip.departure_at, direction: trip.direction, status: trip.status },
  }));

  return { trip, groups, waitlist, acceptedRequests, counts };
});

export function requestPlace(r: Pick<PickupRequest, "pickup_location_id" | "custom_place" | "lat" | "lng">, locations: Map<string, PickupLocation>): string {
  if (r.pickup_location_id) {
    const l = locations.get(r.pickup_location_id);
    if (l) return l.name;
  }
  if (r.custom_place) return r.custom_place;
  if (r.lat != null && r.lng != null) return `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`;
  return "Unknown place";
}

async function decorateRequests(rows: PickupRequest[]): Promise<RequestWithRider[]> {
  if (rows.length === 0) return [];
  const admin = createAdminClient();
  const tripIds = [...new Set(rows.map((r) => r.trip_id).filter((v): v is string => !!v))];
  const [riders, locations, tripsRes] = await Promise.all([
    loadRiders(rows.map((r) => r.rider_id)),
    loadLocations(rows.map((r) => r.pickup_location_id)),
    tripIds.length > 0 ? admin.from("trips").select("id, departure_at, direction, status").in("id", tripIds) : Promise.resolve({ data: [] as Array<Pick<Trip, "id" | "departure_at" | "direction" | "status">> }),
  ]);
  const trips = new Map<string, Pick<Trip, "id" | "departure_at" | "direction" | "status">>();
  for (const t of tripsRes.data ?? []) trips.set(t.id, t);
  return rows.map((r) => ({
    ...r,
    rider: riders.get(r.rider_id) ?? UNKNOWN_RIDER(r.rider_id),
    pickup_name: requestPlace(r, locations),
    trip: r.trip_id ? (trips.get(r.trip_id) ?? null) : null,
  }));
}

/** Pending (not yet expired) pickup requests, oldest first. */
export const listPendingPickupRequests = cache(async (): Promise<RequestWithRider[]> => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("pickup_requests")
    .select("*")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return decorateRequests(data);
});

/** Requests accepted today (any driver), newest first. */
export const listAcceptedRequestsToday = cache(async (): Promise<RequestWithRider[]> => {
  const admin = createAdminClient();
  const { today } = await driverDateRange();
  const settings = await getSettings();
  // Start of the local day in UTC.
  const start = new Date(`${today}T00:00:00Z`);
  const offsetGuess = new Date(start.getTime() - 24 * 3600_000); // generous lower bound; filtered precisely below
  const { data, error } = await admin
    .from("pickup_requests")
    .select("*")
    .in("status", ["accepted", "completed"])
    .gte("responded_at", offsetGuess.toISOString())
    .order("responded_at", { ascending: false });
  if (error || !data) return [];
  const rows = data.filter((r) => r.responded_at && localDateString(r.responded_at, settings.timezone) === today);
  return decorateRequests(rows);
});

/**
 * Route-handler guard: the assigned driver, an admin, or any driver when nobody is
 * assigned yet (`claimable`). Throws ApiError(404 / 403).
 */
export async function requireTripAccess(
  tripId: string,
  actor: Pick<Profile, "id" | "role">,
): Promise<{ trip: Trip; claimable: boolean }> {
  const trip = await getTrip(tripId);
  if (!trip) throw new ApiError(404, "NOT_FOUND", "That trip no longer exists.");
  if (actor.role === "admin" || trip.driver_id === actor.id) return { trip, claimable: false };
  if (trip.driver_id === null) return { trip, claimable: true };
  throw new ApiError(403, "FORBIDDEN", "Another driver is assigned to this trip.");
}

export const pendingRequestCount = cache(async (): Promise<number> => {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("pickup_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString());
  if (error) return 0;
  return count ?? 0;
});
