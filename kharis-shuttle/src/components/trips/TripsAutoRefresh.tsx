"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { TRIP_LOCATION_COLUMNS } from "@/lib/tracking/columns";

export type TripsAutoRefreshProps = {
  /** Also refresh when one of my bookings changes. */
  userId?: string;
  /** Only this trip's row (detail/map pages); otherwise every visible trip. */
  tripId?: string;
  /** Also watch my pickup requests. */
  watchRequests?: boolean;
  /** Debounce window for my bookings / requests in ms (default 1000). */
  debounceMs?: number;
  /** Debounce window for trip rows in ms (default 15 000: the GPS trigger rewrites them often). */
  tripsDebounceMs?: number;
};

/**
 * Trip columns whose change alone should not refresh the Server Component tree:
 * the driver's position (rewritten by the GPS trigger) and the bookkeeping stamp.
 */
const TRIP_IGNORE_COLUMNS: readonly string[] = [...TRIP_LOCATION_COLUMNS, "updated_at"];

/**
 * Invisible: subscribes to postgres_changes on trips (+ my bookings / requests)
 * through useRealtimeInvalidate and router.refresh()es — at most every 15 s for
 * trip rows (location-only updates are ignored outright), once per second for
 * my own bookings / requests — plus once more whenever the tab comes back to
 * the foreground. RLS limits what the browser client can see, so this is only
 * a signal.
 */
export function TripsAutoRefresh({ userId, tripId, watchRequests, debounceMs = 1000, tripsDebounceMs = 15_000 }: TripsAutoRefreshProps) {
  const router = useRouter();

  useRealtimeInvalidate({
    table: "trips",
    filter: tripId ? `id=eq.${tripId}` : undefined,
    debounceMs: tripsDebounceMs,
    ignoreColumns: TRIP_IGNORE_COLUMNS,
  });
  useRealtimeInvalidate({ table: "bookings", filter: userId ? `user_id=eq.${userId}` : undefined, enabled: Boolean(userId), debounceMs });
  useRealtimeInvalidate({
    table: "pickup_requests",
    filter: userId ? `rider_id=eq.${userId}` : undefined,
    enabled: Boolean(userId && watchRequests),
    debounceMs,
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  return null;
}
