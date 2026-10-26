"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { Trip, TripLocationBroadcast } from "@/lib/db.types";
import { createClient } from "@/lib/supabase/client";
import { secondsSince } from "@/lib/time";

/** The subset of a trip the live map cares about. */
export type TripLocationTrip = Pick<
  Trip,
  "id" | "status" | "last_lat" | "last_lng" | "last_heading" | "last_speed_mps" | "last_location_at"
>;

/** One GPS fix as returned by GET /api/trips/[id]/location (broadcast fixes get a negative synthetic id). */
export type TripPoint = {
  id: number;
  lat: number;
  lng: number;
  heading: number | null;
  speed_mps: number | null;
  accuracy_m: number | null;
  recorded_at: string;
};

export type TripLocationSource = "realtime" | "polling" | "idle";

export type UseTripLocationOptions = {
  tripId: string;
  initialTrip: Trip | TripLocationTrip;
  /** settings.location_stale_seconds — after this the bus counts as "not sharing". */
  staleSeconds: number;
};

export type UseTripLocationResult = {
  trip: TripLocationTrip;
  points: TripPoint[];
  lastPoint: TripPoint | null;
  /** Trip is boarding/departed and a fix arrived within staleSeconds. */
  isLive: boolean;
  /** Seconds since the last fix, null when there has never been one. Ticks every second. */
  lastSeenSeconds: number | null;
  source: TripLocationSource;
  /** Force a fetch (e.g. a "refresh" button). */
  refresh: () => Promise<void>;
};

type LocationResponse = {
  trip: TripLocationTrip;
  points: TripPoint[];
};

const POLL_MS = 10_000;
const SUBSCRIBE_GRACE_MS = 5_000;
const MAX_POINTS = 600;

function pickTrip(t: Trip | TripLocationTrip): TripLocationTrip {
  return {
    id: t.id,
    status: t.status,
    last_lat: t.last_lat,
    last_lng: t.last_lng,
    last_heading: t.last_heading,
    last_speed_mps: t.last_speed_mps,
    last_location_at: t.last_location_at,
  };
}

function sortPoints(points: TripPoint[]): TripPoint[] {
  const seen = new Set<string>();
  const out: TripPoint[] = [];
  for (const p of [...points].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))) {
    const key = `${p.recorded_at}|${p.lat.toFixed(6)}|${p.lng.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.length > MAX_POINTS ? out.slice(out.length - MAX_POINTS) : out;
}

/**
 * Live position of one trip's bus for the student map and the driver preview.
 *
 * 1. Initial `GET /api/trips/[id]/location` (full trail), later `?since=<lastId>`.
 * 2. Private realtime channel `trip:<id>`: broadcast `location` fixes (sent by the
 *    DB trigger on every trip_locations insert) + postgres_changes on the trip row
 *    (status / last_* columns).
 * 3. Polling every 10 s when the channel is not SUBSCRIBED within 5 s, or after
 *    CHANNEL_ERROR / TIMED_OUT / CLOSED; refetch whenever the tab becomes visible.
 */
export function useTripLocation({ tripId, initialTrip, staleSeconds }: UseTripLocationOptions): UseTripLocationResult {
  const [trip, setTrip] = useState<TripLocationTrip>(() => pickTrip(initialTrip));
  const [points, setPoints] = useState<TripPoint[]>([]);
  const [source, setSource] = useState<TripLocationSource>("idle");
  const [now, setNow] = useState(() => Date.now());
  const [prevTripId, setPrevTripId] = useState(tripId);
  if (tripId !== prevTripId) {
    // Switched trip without remounting: reset derived state during render (React's sanctioned pattern).
    setPrevTripId(tripId);
    setPoints([]);
    setTrip(pickTrip(initialTrip));
    setSource("idle");
  }

  const lastDbId = useRef<number>(0);
  const pollTimer = useRef<number | null>(null);
  const graceTimer = useRef<number | null>(null);
  const subscribed = useRef(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);

  const fetchLocation = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const since = lastDbId.current > 0 ? `?since=${lastDbId.current}` : "";
        const res = await fetch(`/api/trips/${tripId}/location${since}`, { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as LocationResponse;
        if (!mounted.current) return;
        if (data.trip) setTrip((prev) => ({ ...prev, ...data.trip }));
        if (Array.isArray(data.points) && data.points.length > 0) {
          for (const p of data.points) if (typeof p.id === "number" && p.id > lastDbId.current) lastDbId.current = p.id;
          setPoints((prev) => sortPoints([...prev, ...data.points]));
        }
      } catch {
        // offline or server hiccup: next poll / broadcast will catch up
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
  }, [tripId]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    setSource("polling");
    void fetchLocation();
    pollTimer.current = window.setInterval(() => void fetchLocation(), POLL_MS);
  }, [fetchLocation]);

  // Initial fetch + realtime channel + polling fallback.
  useEffect(() => {
    mounted.current = true;
    lastDbId.current = 0;
    void fetchLocation();

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const onBroadcast = (msg: { payload: TripLocationBroadcast }) => {
      const p = msg.payload;
      if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") return;
      const point: TripPoint = {
        id: -Date.parse(p.recorded_at) || -Date.now(),
        lat: p.lat,
        lng: p.lng,
        heading: p.heading ?? null,
        speed_mps: p.speed_mps ?? null,
        accuracy_m: p.accuracy_m ?? null,
        recorded_at: p.recorded_at,
      };
      setPoints((prev) => sortPoints([...prev, point]));
      setTrip((prev) => {
        if (prev.last_location_at && prev.last_location_at > p.recorded_at) return prev;
        return { ...prev, last_lat: p.lat, last_lng: p.lng, last_heading: p.heading ?? null, last_speed_mps: p.speed_mps ?? null, last_location_at: p.recorded_at };
      });
    };

    (async () => {
      let supabase: ReturnType<typeof createClient>;
      try {
        supabase = createClient();
        // Private channels need the user's JWT on the socket before joining.
        await supabase.realtime.setAuth();
      } catch {
        startPolling();
        return;
      }
      if (cancelled) return;

      channel = supabase
        .channel(`trip:${tripId}`, { config: { private: true } })
        .on<TripLocationBroadcast>("broadcast", { event: "location" }, onBroadcast)
        .on<Trip>(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "trips", filter: `id=eq.${tripId}` },
          (payload) => {
            const row = payload.new;
            if (row && typeof row === "object" && "id" in row) setTrip((prev) => ({ ...prev, ...pickTrip(row) }));
          },
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            subscribed.current = true;
            if (graceTimer.current) {
              window.clearTimeout(graceTimer.current);
              graceTimer.current = null;
            }
            stopPolling();
            setSource("realtime");
            // Catch anything missed while (re)connecting.
            void fetchLocation();
          } else {
            subscribed.current = false;
            startPolling();
          }
        });

      graceTimer.current = window.setTimeout(() => {
        graceTimer.current = null;
        if (!subscribed.current) startPolling();
      }, SUBSCRIBE_GRACE_MS);
    })();

    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchLocation();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (graceTimer.current) window.clearTimeout(graceTimer.current);
      graceTimer.current = null;
      stopPolling();
      if (channel) {
        const supabase = createClient();
        void supabase.removeChannel(channel);
      }
    };
  }, [tripId, fetchLocation, startPolling, stopPolling]);

  // 1 s ticker for "updated 5s ago".
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const lastPoint = points.length > 0 ? (points[points.length - 1] ?? null) : null;
  const lastAt = lastPoint && (!trip.last_location_at || lastPoint.recorded_at >= trip.last_location_at) ? lastPoint.recorded_at : trip.last_location_at;
  const lastSeenSeconds = secondsSince(lastAt, new Date(now));
  const isLive = (trip.status === "boarding" || trip.status === "departed") && lastSeenSeconds != null && lastSeenSeconds <= staleSeconds;

  return { trip, points, lastPoint, isLive, lastSeenSeconds, source, refresh: fetchLocation };
}
