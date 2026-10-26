"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TRACKING_DEFAULTS, shouldSendFix, type Fix } from "@/lib/geo";

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

const BATCH = 10;
const QUEUE_CAP = 50;
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 };
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

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
 * ≥ 3 s apart), 30 s heartbeat while stationary, batches of ≤ 10 points to
 * `POST /api/driver/location`, retry queue with backoff (cap 50), `sendBeacon`
 * on pagehide, Screen Wake Lock (re-requested on visible), paused flag when the
 * page was hidden.
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
  const queue = useRef<OutPoint[]>([]);
  const lastFix = useRef<Fix | null>(null);
  const lastSent = useRef<Fix | null>(null);
  const flushing = useRef(false);
  const failures = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const heartbeat = useRef<number | null>(null);
  const sentinel = useRef<WakeLockSentinelLike | null>(null);
  const active = useRef(false);
  // Lets flush() chain the next batch without referring to itself.
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  const setQueueLen = () => setQueued(queue.current.length);

  const enqueue = useCallback((f: Fix) => {
    queue.current.push(toOut(f));
    if (queue.current.length > QUEUE_CAP) queue.current.splice(0, queue.current.length - QUEUE_CAP);
    lastSent.current = f;
    setQueueLen();
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current || queue.current.length === 0) return;
    flushing.current = true;
    const batch = queue.current.slice(0, BATCH);
    try {
      const res = await fetch("/api/driver/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
        body: JSON.stringify({ trip_id: tripId, points: batch }),
      });
      if (res.ok) {
        queue.current.splice(0, batch.length);
        failures.current = 0;
        setSentCount((n) => n + batch.length);
        setLastSentAt(Date.now());
        setError(null);
        setQueueLen();
        flushing.current = false;
        if (queue.current.length > 0) void flushRef.current();
        return;
      }
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 409) {
        // Not allowed any more (trip ended / not ours): stop sending, keep the UI honest.
        let message = "Tracking was refused for this trip.";
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          // keep default
        }
        queue.current = [];
        setQueueLen();
        setError(message);
        if (res.status === 409 || res.status === 404) {
          active.current = false;
          setStatus("stopped");
        }
        flushing.current = false;
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch {
      failures.current += 1;
      setError(failures.current > 2 ? "No connection — points are queued and will be sent when you’re back online." : null);
      const wait = BACKOFF_MS[Math.min(failures.current - 1, BACKOFF_MS.length - 1)] ?? 30_000;
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        void flushRef.current();
      }, wait);
    } finally {
      flushing.current = false;
    }
  }, [tripId]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const beacon = useCallback(() => {
    if (queue.current.length === 0 || typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const batch = queue.current.slice(0, QUEUE_CAP);
    // text/plain avoids a CORS preflight; the route parses JSON from either content type.
    const blob = new Blob([JSON.stringify({ trip_id: tripId, points: batch })], { type: "text/plain" });
    if (navigator.sendBeacon("/api/driver/location", blob)) {
      queue.current = [];
      setQueueLen();
    }
  }, [tripId]);

  const requestWakeLock = useCallback(async () => {
    const nav = navigator as NavigatorWithWakeLock;
    if (!nav.wakeLock) {
      setWakeLock("unsupported");
      return;
    }
    try {
      const s = await nav.wakeLock.request("screen");
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
      setError(null);
      const decision = shouldSendFix(lastSent.current, fix);
      if (!decision.send) return;
      enqueue(fix);
      void flush();
    },
    [enqueue, flush],
  );

  const onPositionError = useCallback((err: GeolocationPositionError) => {
    if (!active.current) return;
    if (err.code === err.PERMISSION_DENIED) {
      setError("Location access is blocked. Allow it for this app in Settings, then try again.");
      setStatus("error");
      active.current = false;
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      return;
    }
    if (err.code === err.TIMEOUT) setError("Waiting for GPS… move outside if you can.");
    else setError("GPS is unavailable right now.");
  }, []);

  const start = useCallback(() => {
    if (active.current) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This phone can’t share its location.");
      setStatus("error");
      return;
    }
    active.current = true;
    failures.current = 0;
    lastSent.current = null;
    setPaused(false);
    setError(null);
    setStatus("tracking");
    watchId.current = navigator.geolocation.watchPosition(onPosition, onPositionError, WATCH_OPTIONS);
    void requestWakeLock();
    heartbeat.current = window.setInterval(() => {
      if (!active.current) return;
      const f = lastFix.current;
      if (!f) return;
      const since = Date.now() - (lastSent.current?.at ?? 0);
      if (since >= TRACKING_DEFAULTS.heartbeatMs) {
        enqueue({ ...f, at: Date.now() });
        void flush();
      } else if (queue.current.length > 0) {
        void flush();
      }
    }, 5_000);
  }, [enqueue, flush, onPosition, onPositionError, requestWakeLock]);

  const stop = useCallback(async () => {
    active.current = false;
    if (watchId.current != null && typeof navigator !== "undefined") navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (heartbeat.current) window.clearInterval(heartbeat.current);
    heartbeat.current = null;
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    await releaseWakeLock();
    setStatus("stopped");
    setPaused(false);
    if (queue.current.length > 0) await flush();
  }, [flush, releaseWakeLock]);

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
      if (heartbeat.current) window.clearInterval(heartbeat.current);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      const s = sentinel.current;
      sentinel.current = null;
      if (s) void s.release().catch(() => undefined);
      beacon();
    };
  }, [beacon]);

  return { status, accuracy, sentCount, lastSentAt, error, paused, wakeLock, queued, start, stop, resume };
}
