"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

export type TripsAutoRefreshProps = {
  /** Also refresh when one of my bookings changes. */
  userId?: string;
  /** Only this trip's row (detail/map pages); otherwise every visible trip. */
  tripId?: string;
  /** Also watch my pickup requests. */
  watchRequests?: boolean;
  /** Debounce window in ms (default 1000). */
  debounceMs?: number;
};

/**
 * Invisible: subscribes to postgres_changes on trips (+ my bookings / requests)
 * through useRealtimeInvalidate and router.refresh()es at most once per
 * second, plus once more whenever the tab comes back to the foreground.
 * RLS limits what the browser client can see, so this is only a signal.
 */
export function TripsAutoRefresh({ userId, tripId, watchRequests, debounceMs = 1000 }: TripsAutoRefreshProps) {
  const router = useRouter();

  useRealtimeInvalidate({ table: "trips", filter: tripId ? `id=eq.${tripId}` : undefined, debounceMs });
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
