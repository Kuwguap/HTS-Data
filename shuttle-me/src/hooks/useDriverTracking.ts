"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TRACKING_DEFAULTS, shouldSendFix, type Fix } from "@/lib/geo";
import { createFixQueue, type FixQueue, type FixQueueStats } from "@/lib/tracking/fix-queue";

export type TrackingStatus = "idle" | "tracking" | "paused" | "stopped" | "error";
export type WakeLockStatus = "unsupported" | "active" | "released";

export type DriverTrackingState = {
  status: TrackingStatus;
  /** Latest GPS accuracy in metres (null until the first fix). */
  accuracy: number | null;
  /** Points accepted by the server so far. */
  sentCount: number;
  /** Epoch ms of the last successful POST. */
  lastSentAt: number | null;
  /** Sentence-case problem description, or null. */
  error: string | null;
  /** The screen was hidden since tracking started (iOS stops GPS in the background). */
  paused: boolean;
  wakeLock: WakeLockStatus;
  /** Fixes waiting to be sent. */
  queued: number;
  /** Must be called from a tap. */
  start: () => void;
  stop: () => Promise<void>;
  /** Clear the paused flag after the driver returned. */
  resume: () => void;
};

type OutPoint = { lat: number; lng: number; accuracy: number | null; heading: number | null; speed: number | null; at: string };

const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 };
const HEARTBEAT_TICK_MS = 5_000;
/** A fix older than this is not re-stamped as a heartbeat (the stale UI takes over). */
const HEARTBEAT_MAX_FIX_AGE_MS = 2 * TRACKING_DEFAULTS.heartbeatMs;
/** Thrown by send() when the server refused the trip: the queue must not retry. */
class RefusedError extends Error {}
/** Every send-failure message starts with this (so GPS events do not clear it, and a success does). */
const SEND_ERROR_PREFIX = "Couldn’t send";

/** "HTTP 500 — Could not save the location." / "no connection" from a failed send. */
async function describeFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? "";
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (t: "release", cb: () => void) => void };
type NavigatorWithWakeLock = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } };

function toOut(f: Fix): OutPoint {
  return {
    lat: f.lat,
    lng: f.lng,
    accuracy: f.accuracy == null ? null : Math.round(f.accuracy),
    heading: f.heading == null || Number.isNaN(f.heading) ? null : Math.round(f.heading) % 360,
    speed: f.speed == null || Number.isNaN(f.speed) || f.speed < 0 ? null : Math.round(f.speed * 10) / 10,
    at: new Date(f.at).toISOString(),
  };
}

/**
 * Driver-side GPS sharing for one trip. `watchPosition` from a tap, fixes
 * filtered with `shouldSendFix` (accuracy ≤ 100 m, ≥ 15 m moved or ≥ 10 s,
 * ≥ 3 s apart), 30 s heartbeat while stationary (only while the last real fix is
 * fresh), batches of ≤ 10 points to `POST /api/driver/location` through a
 * `createFixQueue` (first fix + heartbeats go out at once, the rest when ≥ 5 are
 * waiting or 8 s after the oldest; retry with backoff; cap 50), `sendBeacon` on
 * pagehide, Screen Wake Lock (re-requested on visible), paused flag when the
 * page was hidden. A failed POST surfaces its HTTP status and server message in
 * `error` (cleared by the next successful send); `sentCount` / `lastSentAt`
 * count acknowledged fixes.
 */
export function useDriverTracking(tripId: string): DriverTrackingState {
  const [status, setStatus] = useState<TrackingStatus>("idle");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [wakeLock, setWakeLock] = useState<WakeLockStatus>("unsupported");
  const [queued, setQueued] = useState(0);

  const watchId = useRef<number | null>(null);
  const lastFix = useRef<Fix | null>(null);
  const lastSent = useRef<Fix | null>(null);
  const heartbeat = useRef<number | null>(null);
  const sentinel = useRef<WakeLockSentinelLike | null>(null);
  const active = useRef(false);
  const queue = useRef<FixQueue<OutPoint> | null>(null);
  const queueTripId = useRef<string | null>(null);
  /** Why the last send failed (HTTP status + server message, or "no connection"); null after a success. */
  const lastSendError = useRef<string | null>(null);

  const onStats = useCallback((s: FixQueueStats) => {
    setQueued(s.queued);
    setSentCount(s.sent);
    setLastSentAt(s.lastSentAt);
    if (s.failures > 0 && lastSendError.current) {
      const why = lastSendError.current;
      setError(`${SEND_ERROR_PREFIX} the last fixes (${why}) — ${s.queued} queued, retrying…`);
    } else if (s.failures === 0 && s.lastSentAt != null) {
      lastSendError.current = null;
      setError((e) => (e && e.startsWith(SEND_ERROR_PREFIX) ? null : e));
    }
  }, []);

  const send = useCallback(
    async (points: OutPoint[]) => {
      const res = await fetch("/api/driver/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
        body: JSON.stringify({ trip_id: tripId, points }),
      });
      if (res.ok) return;
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 409) {
        let message = "Tracking was refused for this trip.";
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          // keep default
        }
        throw new RefusedError(message, { cause: res.status });
      }
      throw new Error(await describeFailure(res));
    },
    [tripId],
  );

  /** The queue for the current trip (recreated when the trip changes). */
  const getQueue = useCallback((): FixQueue<OutPoint> => {
    if (queue.current && queueTripId.current === tripId) return queue.current;
    queue.current?.dispose();
    const q = createFixQueue<OutPoint>({
      send: async (points) => {
        try {
          await send(points);
        } catch (err) {
          if (err instanceof RefusedError) {
            // Not allowed any more (trip ended / not ours): stop sending, keep the UI honest.
            q.clear();
            setError(err.message);
            if (err.cause === 409 || err.cause === 404) {
              active.current = false;
              setStatus("stopped");
            }
            return;
          }
          // fetch() rejects with a TypeError when offline; anything else carries the HTTP text.
          lastSendError.current = err instanceof TypeError ? "no connection" : err instanceof Error ? err.message : String(err);
          throw err;
        }
      },
      onChange: onStats,
    });
    queue.current = q;
    queueTripId.current = tripId;
    return q;
  }, [tripId, send, onStats]);

  const flush = useCallback(() => getQueue().flush(), [getQueue]);

  const beacon = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.sendBeacon || !queue.current) return;
    const q = queue.current;
    const points = q.drainForBeacon();
    if (points.length === 0) return;
    // text/plain avoids a CORS preflight; the route parses JSON from either content type.
    const blob = new Blob([JSON.stringify({ trip_id: queueTripId.current ?? tripId, points })], { type: "text/plain" });
    if (!navigator.sendBeacon("/api/driver/location", blob)) q.requeue(points);
  }, [tripId]);

  const requestWakeLock = useCallback(async () => {
    const nav = navigator as NavigatorWithWakeLock;
    if (!nav.wakeLock) {
      setWakeLock("unsupported");
      return;
    }
    try {
      const s = await nav.wakeLock.request("screen");
      if (!active.current) {
        // Tracking stopped while the request was pending.
        void s.release().catch(() => undefined);
        return;
      }
      sentinel.current = s;
      setWakeLock("active");
      s.addEventListener("release", () => {
        if (sentinel.current === s) sentinel.current = null;
        setWakeLock("released");
      });
    } catch {
      setWakeLock("released");
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    const s = sentinel.current;
    sentinel.current = null;
    if (s) {
      try {
        await s.release();
      } catch {
        // already released
      }
    }
    setWakeLock((w) => (w === "unsupported" ? w : "released"));
  }, []);

  /** Stop GPS, the heartbeat, pending timers and the wake lock (shared by stop() and the error path). */
  const teardown = useCallback(async () => {
    active.current = false;
    if (watchId.current != null && typeof navigator !== "undefined" && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (heartbeat.current != null) window.clearInterval(heartbeat.current);
    heartbeat.current = null;
    queue.current?.dispose();
    await releaseWakeLock();
  }, [releaseWakeLock]);

  const onPosition = useCallback(
    (pos: GeolocationPosition) => {
      if (!active.current) return;
      const c = pos.coords;
      const fix: Fix = {
        lat: c.latitude,
        lng: c.longitude,
        accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
        heading: c.heading == null || Number.isNaN(c.heading) ? null : c.heading,
        speed: c.speed == null || Number.isNaN(c.speed) ? null : c.speed,
        at: Date.now(),
      };
      lastFix.current = fix;
      setAccuracy(fix.accuracy);
      setError((e) => (e && e.startsWith(SEND_ERROR_PREFIX) ? e : null));
      const decision = shouldSendFix(lastSent.current, fix);
      if (!decision.send) return;
      lastSent.current = fix;
      // First fix and stationary heartbeats go out at once; movement batches up.
      getQueue().enqueue(toOut(fix), { immediate: decision.reason === "first" || decision.reason === "heartbeat" });
    },
    [getQueue],
  );

  const onPositionError = useCallback(
    (err: GeolocationPositionError) => {
      if (!active.current) return;
      if (err.code === err.PERMISSION_DENIED) {
        void teardown();
        setError("Location access is blocked. Allow it for this app in Settings, then try again.");
        setStatus("error");
        return;
      }
      if (err.code === err.TIMEOUT) setError("Waiting for GPS… move outside if you can.");
      else setError("GPS is unavailable right now.");
    },
    [teardown],
  );

  const start = useCallback(() => {
    if (active.current) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This phone can’t share its location.");
      setStatus("error");
      return;
    }
    // Never stack watchers / intervals from an earlier run.
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (heartbeat.current != null) window.clearInterval(heartbeat.current);
    heartbeat.current = null;

    active.current = true;
    lastSent.current = null;
    lastFix.current = null;
    setPaused(false);
    setError(null);
    setStatus("tracking");
    getQueue();
    watchId.current = navigator.geolocation.watchPosition(onPosition, onPositionError, WATCH_OPTIONS);
    void requestWakeLock();
    heartbeat.current = window.setInterval(() => {
      if (!active.current) return;
      const f = lastFix.current;
      if (!f) return;
      const now = Date.now();
      // Only re-stamp a fix that is still fresh and passed the accuracy gate.
      if (now - f.at > HEARTBEAT_MAX_FIX_AGE_MS) return;
      if (f.accuracy != null && f.accuracy > TRACKING_DEFAULTS.maxAccuracyM) return;
      if (now - (lastSent.current?.at ?? 0) < TRACKING_DEFAULTS.heartbeatMs) return;
      const stamped: Fix = { ...f, at: now };
      lastSent.current = stamped;
      getQueue().enqueue(toOut(stamped), { immediate: true });
    }, HEARTBEAT_TICK_MS);
  }, [getQueue, onPosition, onPositionError, requestWakeLock]);

  const stop = useCallback(async () => {
    await teardown();
    setStatus("stopped");
    setPaused(false);
    await flush();
  }, [teardown, flush]);

  const resume = useCallback(() => setPaused(false), []);

  // Visibility / pagehide handling while tracking.
  useEffect(() => {
    const onVisibility = () => {
      if (!active.current) return;
      if (document.visibilityState === "hidden") {
        setPaused(true);
        setStatus("paused");
        beacon();
      } else {
        setStatus("tracking");
        void requestWakeLock();
        void flush();
      }
    };
    const onPageHide = () => {
      if (active.current) beacon();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [beacon, flush, requestWakeLock]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      active.current = false;
      if (watchId.current != null && typeof navigator !== "undefined" && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      if (heartbeat.current != null) window.clearInterval(heartbeat.current);
      heartbeat.current = null;
      const s = sentinel.current;
      sentinel.current = null;
      if (s) void s.release().catch(() => undefined);
      beacon();
      queue.current?.dispose();
    };
  }, [beacon]);

  return { status, accuracy, sentCount, lastSentAt, error, paused, wakeLock, queued, start, stop, resume };
}
