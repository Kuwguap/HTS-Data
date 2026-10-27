"use client";

import { useEffect, useRef, useState } from "react";
import { distanceToPolylineM, type LatLng } from "@/lib/geo";

/** The road route ahead of the bus, as GET /api/trips/[id]/route returns it. */
export type TripRoute = {
  geometry: LatLng[];
  distanceM: number;
  durationS: number;
  /** from→via (when a via point was sent) and via→destination, or just from→destination. */
  legs: { distanceM: number; durationS: number }[];
  destination: LatLng;
  from: LatLng;
  /** Which via point the route was computed for ("" when none). */
  viaKey: string;
};

/** The travelled trail snapped to roads, as GET /api/trips/[id]/matched returns it. */
export type MatchedTrail = {
  geometry: LatLng[];
  confidence: number;
  /** recorded_at bounds of the raw fixes the geometry covers (null when unknown). */
  fromRecordedAt: string | null;
  throughRecordedAt: string | null;
};

export type UseTripRouteOptions = {
  tripId: string;
  /** Latest known bus position (route "from"). */
  busPos: LatLng | null;
  /** The viewer's own pickup while the bus is still on its way there; null otherwise. */
  viaPos: LatLng | null;
  /** Only while the trip is boarding/departed; false clears the route ahead. */
  enabled: boolean;
  /** Identity of the newest raw fix (DB id or synthetic); a change means new points arrived. */
  latestPointKey: string | number | null;
};

export type UseTripRouteResult = { route: TripRoute | null; matched: MatchedTrail | null };

type RouteResponse = {
  route: { geometry: LatLng[]; distance_m: number; duration_s: number; legs: { distance_m: number; duration_s: number }[] } | null;
  destination?: LatLng;
  from?: LatLng;
};

type MatchedResponse = {
  geometry: LatLng[] | null;
  confidence: number;
  from_recorded_at?: string | null;
  through_recorded_at?: string | null;
};

/** The bus is "off route" once it is this far from the route polyline. */
const OFF_ROUTE_M = 60;
/** A route is refreshed at least this often even when the bus is on it. */
const ROUTE_REFRESH_MS = 60_000;
/** Never ask for a route more often than this. */
const ROUTE_MIN_INTERVAL_MS = 15_000;
/** Never ask for the matched trail more often than this. */
const MATCH_MIN_INTERVAL_MS = 15_000;

/** Identity of a via point as the hook compares it (5 decimals ≈ 1 m). */
export function viaKeyOf(p: LatLng | null): string {
  return p ? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : "";
}

/**
 * Road geometry for the live map: the route ahead (bus → via → destination) and the
 * travelled trail snapped to roads. Both are best-effort — a failed fetch keeps the
 * last good answer and the map falls back to straight lines when nothing is known.
 *
 * Route: fetched when enabled and a bus position exists; re-fetched when the bus is
 * more than 60 m from the route, every 60 s, or when the via point changes — at most
 * once per 15 s. Matched trail: fetched on mount and whenever new points arrive, at
 * most once per 15 s.
 */
export function useTripRoute({ tripId, busPos, viaPos, enabled, latestPointKey }: UseTripRouteOptions): UseTripRouteResult {
  const [route, setRoute] = useState<TripRoute | null>(null);
  const [matched, setMatched] = useState<MatchedTrail | null>(null);
  const [prevTripId, setPrevTripId] = useState(tripId);
  if (tripId !== prevTripId) {
    setPrevTripId(tripId);
    setRoute(null);
    setMatched(null);
  }

  const lastRouteFetchAt = useRef(0);
  const routeInFlight = useRef(false);
  const lastMatchFetchAt = useRef(0);
  const matchInFlight = useRef(false);
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current += 1;
    lastRouteFetchAt.current = 0;
    lastMatchFetchAt.current = 0;
    routeInFlight.current = false;
    matchInFlight.current = false;
    return () => {
      epoch.current += 1;
    };
  }, [tripId]);

  // Route ahead (`route` is a dependency on purpose: after a fetch lands the timers are re-armed from the new geometry).
  useEffect(() => {
    if (!enabled || !busPos) return;
    const myEpoch = epoch.current;
    let timer: number | null = null;
    let cancelled = false;
    const viaKey = viaKeyOf(viaPos);

    const fetchRoute = async () => {
      if (routeInFlight.current) return;
      routeInFlight.current = true;
      lastRouteFetchAt.current = Date.now();
      try {
        const via = viaPos ? `?via=${viaPos.lat},${viaPos.lng}` : "";
        const res = await fetch(`/api/trips/${tripId}/route${via}`, { credentials: "same-origin" });
        if (!res.ok || epoch.current !== myEpoch) return;
        const data = (await res.json()) as RouteResponse;
        if (epoch.current !== myEpoch) return;
        if (data.route && data.destination && data.from && Array.isArray(data.route.geometry) && data.route.geometry.length >= 2) {
          setRoute({
            geometry: data.route.geometry,
            distanceM: data.route.distance_m,
            durationS: data.route.duration_s,
            legs: data.route.legs.map((l) => ({ distanceM: l.distance_m, durationS: l.duration_s })),
            destination: data.destination,
            from: data.from,
            viaKey,
          });
        }
        // route null (no position / destination / router down): keep whatever we had.
      } catch {
        // offline: keep the last good route
      } finally {
        if (epoch.current === myEpoch) routeInFlight.current = false;
        // A successful fetch re-runs this effect through `route`; after a failure (or a
        // null route) nothing changes, so re-arm the check even if the bus stands still.
        if (!cancelled) timer = window.setTimeout(attempt, ROUTE_MIN_INTERVAL_MS);
      }
    };

    const attempt = () => {
      const now = Date.now();
      const current = route;
      const sinceLast = now - lastRouteFetchAt.current;
      const offRoute = !current || distanceToPolylineM(busPos, current.geometry) > OFF_ROUTE_M;
      const viaChanged = !!current && current.viaKey !== viaKey;
      const stale = sinceLast >= ROUTE_REFRESH_MS;
      if (!(offRoute || viaChanged || stale)) {
        timer = window.setTimeout(attempt, Math.max(1_000, ROUTE_REFRESH_MS - sinceLast));
        return;
      }
      if (sinceLast < ROUTE_MIN_INTERVAL_MS) {
        timer = window.setTimeout(attempt, ROUTE_MIN_INTERVAL_MS - sinceLast);
        return;
      }
      void fetchRoute();
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [tripId, enabled, busPos, viaPos, route]);

  // Matched (road-snapped) trail.
  useEffect(() => {
    if (latestPointKey == null) return;
    const myEpoch = epoch.current;
    let timer: number | null = null;

    const fetchMatched = async () => {
      if (matchInFlight.current) return;
      matchInFlight.current = true;
      lastMatchFetchAt.current = Date.now();
      try {
        const res = await fetch(`/api/trips/${tripId}/matched`, { credentials: "same-origin" });
        if (!res.ok || epoch.current !== myEpoch) return;
        const data = (await res.json()) as MatchedResponse;
        if (epoch.current !== myEpoch) return;
        if (Array.isArray(data.geometry) && data.geometry.length >= 2) {
          setMatched({
            geometry: data.geometry,
            confidence: data.confidence,
            fromRecordedAt: data.from_recorded_at ?? null,
            throughRecordedAt: data.through_recorded_at ?? null,
          });
        }
        // null geometry (router down / too few fixes): keep the last good trail.
      } catch {
        // offline: keep the last good trail
      } finally {
        if (epoch.current === myEpoch) matchInFlight.current = false;
      }
    };

    const wait = MATCH_MIN_INTERVAL_MS - (Date.now() - lastMatchFetchAt.current);
    if (wait <= 0) void fetchMatched();
    else timer = window.setTimeout(() => void fetchMatched(), wait);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [tripId, latestPointKey]);

  // A finished / cancelled trip has no road ahead; the last route is kept only for a trip that becomes live again.
  return { route: enabled ? route : null, matched };
}
