/**
 * "Shuttle is close" pushes. After the driver's location batch is stored, riders
 * still waiting (confirmed, not boarded) whose pickup point is within
 * APPROACH_RADIUS_M of the newest fix get trip_approaching once per booking.
 * Pure decision in `approachingRiders`; `notifyApproaching` does the one select
 * and the enqueues, and never throws (a push problem must not break the 204).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Trip } from "@/lib/db.types";
import { haversineM, type LatLng } from "@/lib/geo";
import { AFTER_DRAIN_BUDGET_MS, enqueueNotification, scheduleDrain, type EnqueueInput } from "@/lib/notify/enqueue";

type Admin = SupabaseClient<Database>;

export const APPROACH_RADIUS_M = 400;
/** ~23 km/h, the same urban shuttle speed estimateEtaSeconds assumes. */
export const APPROACH_SPEED_M_PER_MIN = 23_000 / 60;
export const APPROACH_TTL_SECONDS = 600;

export type WaitingRider = {
  booking_id: string;
  user_id: string;
  /** Booking status as stored; only "confirmed" riders are considered. */
  status: string;
  pickup: (LatLng & { id: string; name: string }) | null;
};

export type ApproachNotice = { booking_id: string; user_id: string; pickup_name: string; distance_m: number; minutes: number };

/** Minutes a bus needs for `distanceM` at shuttle speed, never below 1. */
export function approachMinutes(distanceM: number): number {
  return Math.max(1, Math.round(distanceM / APPROACH_SPEED_M_PER_MIN));
}

/** Confirmed riders with a pickup point within the radius of `bus`, nearest first. */
export function approachingRiders(bus: LatLng, riders: WaitingRider[], radiusM = APPROACH_RADIUS_M): ApproachNotice[] {
  const out: ApproachNotice[] = [];
  for (const r of riders) {
    if (r.status !== "confirmed" || !r.pickup) continue;
    const distance_m = haversineM(bus, r.pickup);
    if (distance_m > radiusM) continue;
    out.push({ booking_id: r.booking_id, user_id: r.user_id, pickup_name: r.pickup.name, distance_m, minutes: approachMinutes(distance_m) });
  }
  return out.sort((a, b) => a.distance_m - b.distance_m);
}

/** Dedupe prefix: once per booking, so a rider is told a single time per trip. */
export function approachDedupePrefix(tripId: string, bookingId: string): string {
  return `approach:${tripId}:${bookingId}`;
}

/** The notification for one rider (vars {count} minutes, {pickup}, plus the trip labels). */
export function approachNotice(trip: Pick<Trip, "id">, n: ApproachNotice, vars: Record<string, string> = {}): EnqueueInput {
  return {
    userIds: [n.user_id],
    kind: "trip_approaching",
    vars: { ...vars, count: n.minutes, pickup: n.pickup_name, trip_id: trip.id },
    url: `/app/trips/${trip.id}/map`,
    dedupePrefix: approachDedupePrefix(trip.id, n.booking_id),
    ttlSeconds: APPROACH_TTL_SECONDS,
    urgency: "high",
    collapseTag: `trip:${trip.id}`,
  };
}

type BookingJoinRow = {
  id: string;
  user_id: string;
  status: string;
  pickup_locations: { id: string; name: string; lat: number; lng: number } | null;
};

/**
 * Load the trip's confirmed riders with their pickup coordinates (one select, joined
 * through bookings.pickup_location_id), enqueue trip_approaching for those within the
 * radius of `bus`, and schedule one drain. Resolves to the number of rows enqueued; 0
 * on any error (logged).
 */
export async function notifyApproaching(admin: Admin, trip: Pick<Trip, "id">, bus: LatLng, vars: Record<string, string> = {}): Promise<number> {
  try {
    const { data, error } = await admin
      .from("bookings")
      .select("id, user_id, status, pickup_locations(id, name, lat, lng)")
      .eq("trip_id", trip.id)
      .eq("status", "confirmed")
      .not("pickup_location_id", "is", null);
    if (error) {
      console.error("[approaching] select failed:", error.message);
      return 0;
    }
    const riders: WaitingRider[] = ((data ?? []) as unknown as BookingJoinRow[]).map((b) => ({
      booking_id: b.id,
      user_id: b.user_id,
      status: b.status,
      pickup: b.pickup_locations ? { id: b.pickup_locations.id, name: b.pickup_locations.name, lat: b.pickup_locations.lat, lng: b.pickup_locations.lng } : null,
    }));
    let count = 0;
    for (const n of approachingRiders(bus, riders)) count += await enqueueNotification(admin, approachNotice(trip, n, vars));
    if (count > 0) await scheduleDrain({ admin, budgetMs: AFTER_DRAIN_BUDGET_MS });
    return count;
  } catch (err) {
    console.error("[approaching] failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}
