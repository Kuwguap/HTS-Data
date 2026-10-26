import "server-only";

/** Helpers shared by the admin trip routes (not a route: no route.ts here). */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingStatus, Database, NotificationKind, Settings, Trip } from "@/lib/db.types";
import { notifyAndDrain, type TemplateVars } from "@/lib/notify/enqueue";
import { formatFare, formatShortDate, formatTime } from "@/lib/time";
import { seatsLeft } from "@/lib/trips";

type Admin = SupabaseClient<Database>;

/** Placeholder values describing a trip, in the hostel's timezone. */
export function tripVars(trip: Trip, settings: Settings): TemplateVars {
  return {
    time: formatTime(trip.departure_at, settings.timezone),
    date: formatShortDate(trip.departure_at, settings.timezone),
    origin: trip.origin_label,
    destination: trip.destination_label,
    seats: trip.seat_capacity,
    seats_left: seatsLeft(trip),
    fare: formatFare(settings.fare_pesewas, settings.currency),
    hostel: settings.hostel_name,
    campus: settings.campus_name,
  };
}

/** User ids of riders on a trip with one of the given booking statuses. */
export async function riderIds(admin: Admin, tripId: string, statuses: BookingStatus[]): Promise<string[]> {
  const { data, error } = await admin.from("bookings").select("user_id").eq("trip_id", tripId).in("status", statuses);
  if (error) {
    console.error("[admin] riderIds failed:", error.message);
    return [];
  }
  return [...new Set((data ?? []).map((b) => b.user_id))];
}

export const ACTIVE_RIDER_STATUSES: BookingStatus[] = ["confirmed", "waitlisted", "boarded"];

/** Notify the trip's active riders (confirmed, waitlisted, boarded) about a trip-level event. */
export async function notifyTripRiders(
  admin: Admin,
  trip: Trip,
  settings: Settings,
  kind: NotificationKind,
  opts: { message?: string | null; dedupePrefix: string; statuses?: BookingStatus[] },
): Promise<number> {
  const ids = await riderIds(admin, trip.id, opts.statuses ?? ACTIVE_RIDER_STATUSES);
  if (ids.length === 0) return 0;
  return notifyAndDrain(admin, {
    userIds: ids,
    kind,
    vars: { ...tripVars(trip, settings), message: opts.message ?? "" },
    url: `/app/trips/${trip.id}`,
    dedupePrefix: opts.dedupePrefix,
    urgency: "high",
    collapseTag: `trip:${trip.id}`,
  });
}
