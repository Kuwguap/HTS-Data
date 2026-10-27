/**
 * Pure send queue for driver GPS fixes (no React, no DOM): batching, a single
 * in-flight loop, identity-based acknowledgement, retry with backoff, a cap that
 * drops the oldest points, and a "beacon drain" that hands over everything not
 * currently in flight. `useDriverTracking` runs on top of it; the unit tests in
 * tests/unit/tracking-queue.test.ts pin the semantics.
 */

export type FixQueueStats = {
  /** Points waiting (including the batch currently being sent). */
  queued: number;
  /** Size of the batch currently being sent (0 when idle). */
  inFlight: number;
  /** Points acknowledged by `send` so far. */
  sent: number;
  /** Consecutive failed sends (reset on success). */
  failures: number;
  /** Epoch ms of the last successful send. */
  lastSentAt: number | null;
  /** Epoch ms of the next automatic retry, null when none is armed. */
  nextRetryAt: number | null;
};

export type FixQueueOptions<T> = {
  /** Deliver one batch; resolve = every point acknowledged, reject = keep them and retry. */
  send: (points: T[]) => Promise<void>;
  /** Max points per send (default 10). */
  maxBatch?: number;
  /** Max points kept; the oldest ones not in flight are dropped first (default 50). */
  maxQueue?: number;
  /** A non-immediate point waits at most this long (measured from the oldest queued point) before a flush (default 8 s). */
  minFlushMs?: number;
  /** Queue length that triggers a flush without waiting (default 5). */
  flushAt?: number;
  /** Retry delays after consecutive failures; the last one repeats. */
  backoffMs?: readonly number[];
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called after every change to the stats. */
  onChange?: (stats: FixQueueStats) => void;
};

export type FixQueue<T> = {
  /** Add a point. `immediate` flushes right away; otherwise the debounce rules apply. */
  enqueue: (point: T, opts?: { immediate?: boolean }) => void;
  /** Send everything, batch by batch. Concurrent calls share the in-flight promise. */
  flush: () => Promise<void>;
  /** Remove and return every point that is NOT in the in-flight batch (for navigator.sendBeacon). */
  drainForBeacon: () => T[];
  /** Put points back at the front (e.g. when sendBeacon refused them). */
  requeue: (points: T[]) => void;
  /** Drop every point and cancel timers (the server refused the trip, or tracking stopped). */
  clear: () => void;
  stats: () => FixQueueStats;
  /** Cancel timers; the queue can still be flushed manually afterwards. */
  dispose: () => void;
};

export const FIX_QUEUE_DEFAULTS = {
  maxBatch: 10,
  maxQueue: 50,
  minFlushMs: 8_000,
  flushAt: 5,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as readonly number[],
} as const;

export function createFixQueue<T extends object>(options: FixQueueOptions<T>): FixQueue<T> {
  const maxBatch = Math.max(1, options.maxBatch ?? FIX_QUEUE_DEFAULTS.maxBatch);
  const maxQueue = Math.max(1, options.maxQueue ?? FIX_QUEUE_DEFAULTS.maxQueue);
  const minFlushMs = Math.max(0, options.minFlushMs ?? FIX_QUEUE_DEFAULTS.minFlushMs);
  const flushAt = Math.max(1, options.flushAt ?? FIX_QUEUE_DEFAULTS.flushAt);
  const backoff = options.backoffMs && options.backoffMs.length > 0 ? options.backoffMs : FIX_QUEUE_DEFAULTS.backoffMs;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let queue: T[] = [];
  const enqueuedAt = new WeakMap<T, number>();
  let inFlightBatch: T[] | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let sent = 0;
  let failures = 0;
  let lastSentAt: number | null = null;
  let retryTimer: unknown = null;
  let nextRetryAt: number | null = null;
  let debounceTimer: unknown = null;

  const stats = (): FixQueueStats => ({
    queued: queue.length,
    inFlight: inFlightBatch?.length ?? 0,
    sent,
    failures,
    lastSentAt,
    nextRetryAt,
  });
  const changed = () => options.onChange?.(stats());

  const cancelRetry = () => {
    if (retryTimer != null) clearTimer(retryTimer);
    retryTimer = null;
    nextRetryAt = null;
  };
  const cancelDebounce = () => {
    if (debounceTimer != null) clearTimer(debounceTimer);
    debounceTimer = null;
  };

  const inFlightSet = () => new Set<T>(inFlightBatch ?? []);

  const enforceCap = () => {
    if (queue.length <= maxQueue) return;
    const pinned = inFlightSet();
    let excess = queue.length - maxQueue;
    queue = queue.filter((p) => {
      if (excess > 0 && !pinned.has(p)) {
        excess -= 1;
        return false;
      }
      return true;
    });
  };

  const runLoop = async (): Promise<void> => {
    try {
      while (queue.length > 0) {
        const batch = queue.slice(0, maxBatch);
        inFlightBatch = batch;
        changed();
        try {
          await options.send(batch);
        } catch {
          inFlightBatch = null;
          failures += 1;
          if (queue.length > 0) {
            const wait = backoff[Math.min(failures - 1, backoff.length - 1)] ?? 30_000;
            cancelRetry();
            nextRetryAt = now() + wait;
            retryTimer = setTimer(() => {
              retryTimer = null;
              nextRetryAt = null;
              void flush();
            }, wait);
          }
          changed();
          return;
        }
        // Remove exactly the acknowledged objects: points enqueued meanwhile stay,
        // and points clear()ed while in flight are not counted as sent.
        const acked = new Set(batch);
        const before = queue.length;
        queue = queue.filter((p) => !acked.has(p));
        inFlightBatch = null;
        failures = 0;
        sent += before - queue.length;
        lastSentAt = now();
        changed();
      }
    } finally {
      inFlightBatch = null;
      inFlightPromise = null;
      changed();
    }
  };

  const flush = (): Promise<void> => {
    if (inFlightPromise) return inFlightPromise;
    cancelDebounce();
    cancelRetry();
    if (queue.length === 0) return Promise.resolve();
    inFlightPromise = runLoop();
    return inFlightPromise;
  };

  const scheduleDebounce = () => {
    if (debounceTimer != null || inFlightPromise) return;
    const oldest = queue.length > 0 ? queue[0] : undefined;
    const since = oldest ? (enqueuedAt.get(oldest) ?? now()) : now();
    const wait = Math.max(0, since + minFlushMs - now());
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      void flush();
    }, wait);
  };

  const enqueue = (point: T, opts?: { immediate?: boolean }) => {
    enqueuedAt.set(point, now());
    queue.push(point);
    enforceCap();
    changed();
    if (opts?.immediate || queue.length - (inFlightBatch?.length ?? 0) >= flushAt) {
      // During a backoff an explicit nudge tries again now (the driver is moving).
      void flush();
      return;
    }
    if (retryTimer != null) return; // keep the backoff; the retry picks this point up
    scheduleDebounce();
  };

  const drainForBeacon = (): T[] => {
    const pinned = inFlightSet();
    const out = queue.filter((p) => !pinned.has(p));
    if (out.length === 0) return out;
    queue = queue.filter((p) => pinned.has(p));
    cancelDebounce();
    changed();
    return out;
  };

  const requeue = (points: T[]) => {
    if (points.length === 0) return;
    const existing = new Set(queue);
    const fresh = points.filter((p) => !existing.has(p));
    for (const p of fresh) if (!enqueuedAt.has(p)) enqueuedAt.set(p, now());
    queue = [...fresh, ...queue];
    enforceCap();
    changed();
    if (!inFlightPromise && retryTimer == null) scheduleDebounce();
  };

  const clear = () => {
    // The in-flight batch goes too: the loop removes by identity, so it neither
    // counts those points as sent nor retries them.
    queue = [];
    cancelDebounce();
    cancelRetry();
    failures = 0;
    changed();
  };

  const dispose = () => {
    cancelDebounce();
    cancelRetry();
  };

  return { enqueue, flush, drainForBeacon, requeue, clear, stats, dispose };
}
