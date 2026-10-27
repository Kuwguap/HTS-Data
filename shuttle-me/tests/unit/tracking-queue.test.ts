import { describe, expect, it, vi } from "vitest";
import { TRIP_LOCATION_COLUMNS, isIgnorableChange } from "@/lib/tracking/columns";
import { FIX_QUEUE_DEFAULTS, createFixQueue, type FixQueueOptions } from "@/lib/tracking/fix-queue";

type Pt = { id: string };
const pt = (id: string): Pt => ({ id });
const ids = (batch: Pt[]) => batch.map((p) => p.id);

/** A controllable `send`: each call parks until the test resolves or rejects it. */
function manualSend() {
  const calls: Array<{ points: Pt[]; resolve: () => void; reject: (e: Error) => void }> = [];
  const send = vi.fn((points: Pt[]) => {
    return new Promise<void>((resolve, reject) => {
      calls.push({ points, resolve, reject });
    });
  });
  return { send, calls };
}

/** Fake clock + timers so debounce/backoff are deterministic. */
function fakeClock() {
  let t = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const setTimer = (fn: () => void, ms: number) => {
    const h = ++seq;
    timers.set(h, { at: t + ms, fn });
    return h;
  };
  const clearTimer = (h: unknown) => {
    timers.delete(h as number);
  };
  const advance = async (ms: number) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await flushMicrotasks();
    }
    t = target;
  };
  return { now: () => t, setTimer, clearTimer, advance, pending: () => timers.size };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function make(overrides: Partial<FixQueueOptions<Pt>> = {}) {
  const clock = fakeClock();
  const { send, calls } = manualSend();
  const q = createFixQueue<Pt>({ send, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...overrides });
  return { q, send, calls, clock };
}

describe("createFixQueue", () => {
  it("has the documented defaults", () => {
    expect(FIX_QUEUE_DEFAULTS).toMatchObject({ maxBatch: 10, maxQueue: 50, minFlushMs: 8_000, flushAt: 5 });
  });

  it("concurrent flushes share one in-flight loop and send each point exactly once", async () => {
    const { q, send, calls } = make();
    q.enqueue(pt("a"));
    q.enqueue(pt("b"));
    q.enqueue(pt("c"));
    const p1 = q.flush();
    const p2 = q.flush();
    const p3 = q.flush();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);
    expect(ids(calls[0]!.points)).toEqual(["a", "b", "c"]);
    expect(q.stats().inFlight).toBe(3);
    calls[0]!.resolve();
    await p1;
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.stats()).toMatchObject({ queued: 0, inFlight: 0, sent: 3, failures: 0 });
  });

  it("sends in batches of maxBatch, one after the other, and a flush during the loop joins it", async () => {
    const { q, send, calls } = make({ maxBatch: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) q.enqueue(pt(id));
    const p = q.flush();
    await flushMicrotasks();
    expect(ids(calls[0]!.points)).toEqual(["a", "b"]);
    const p2 = q.flush();
    expect(p2).toBe(p);
    calls[0]!.resolve();
    await flushMicrotasks();
    expect(ids(calls[1]!.points)).toEqual(["c", "d"]);
    calls[1]!.resolve();
    await flushMicrotasks();
    expect(ids(calls[2]!.points)).toEqual(["e"]);
    calls[2]!.resolve();
    await p;
    expect(send).toHaveBeenCalledTimes(3);
    expect(q.stats().sent).toBe(5);
    expect(q.stats().queued).toBe(0);
  });

  it("keeps the points and retries with backoff when send fails", async () => {
    const { q, send, calls, clock } = make({ backoffMs: [1_000, 5_000] });
    q.enqueue(pt("a"));
    q.enqueue(pt("b"));
    const p = q.flush();
    await flushMicrotasks();
    calls[0]!.reject(new Error("offline"));
    await p;
    expect(q.stats()).toMatchObject({ queued: 2, inFlight: 0, sent: 0, failures: 1 });
    expect(q.stats().nextRetryAt).toBe(clock.now() + 1_000);
    expect(send).toHaveBeenCalledTimes(1);

    await clock.advance(1_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ids(calls[1]!.points)).toEqual(["a", "b"]);
    calls[1]!.reject(new Error("still offline"));
    await flushMicrotasks();
    expect(q.stats().failures).toBe(2);
    expect(q.stats().nextRetryAt).toBe(clock.now() + 5_000);

    await clock.advance(5_000);
    expect(send).toHaveBeenCalledTimes(3);
    calls[2]!.resolve();
    await flushMicrotasks();
    expect(q.stats()).toMatchObject({ queued: 0, sent: 2, failures: 0, nextRetryAt: null });
  });

  it("removes acknowledged points by identity so points enqueued mid-flight survive", async () => {
    const { q, calls } = make();
    const a = pt("a");
    const b = pt("b");
    q.enqueue(a);
    q.enqueue(b);
    const p = q.flush();
    await flushMicrotasks();
    expect(ids(calls[0]!.points)).toEqual(["a", "b"]);
    const c = pt("c");
    const d = pt("d");
    q.enqueue(c);
    q.enqueue(d);
    expect(q.stats()).toMatchObject({ queued: 4, inFlight: 2 });
    calls[0]!.resolve();
    await flushMicrotasks();
    // The loop continued with exactly the later points.
    expect(ids(calls[1]!.points)).toEqual(["c", "d"]);
    expect(calls[1]!.points[0]).toBe(c);
    expect(calls[1]!.points[1]).toBe(d);
    calls[1]!.resolve();
    await p;
    expect(q.stats()).toMatchObject({ queued: 0, sent: 4 });
  });

  it("drainForBeacon hands over only the points that are not in flight", async () => {
    const { q, calls } = make();
    const a = pt("a");
    const b = pt("b");
    q.enqueue(a);
    q.enqueue(b);
    const p = q.flush();
    await flushMicrotasks();
    const c = pt("c");
    q.enqueue(c);
    const drained = q.drainForBeacon();
    expect(drained).toEqual([c]);
    expect(q.stats()).toMatchObject({ queued: 2, inFlight: 2 });
    calls[0]!.resolve();
    await p;
    expect(q.stats()).toMatchObject({ queued: 0, sent: 2 });
    // Nothing left: a second drain is empty.
    expect(q.drainForBeacon()).toEqual([]);
  });

  it("drainForBeacon takes everything when idle; requeue puts refused points back in order", () => {
    const { q } = make();
    const a = pt("a");
    const b = pt("b");
    q.enqueue(a);
    q.enqueue(b);
    expect(q.drainForBeacon()).toEqual([a, b]);
    expect(q.stats().queued).toBe(0);
    q.requeue([a, b]);
    q.enqueue(pt("c"));
    expect(q.drainForBeacon()).toEqual([a, b, { id: "c" }]);
  });

  it("caps the queue by dropping the oldest points, never the in-flight batch", async () => {
    const { q, calls } = make({ maxQueue: 4, flushAt: 100 });
    for (const id of ["a", "b", "c", "d", "e", "f"]) q.enqueue(pt(id));
    expect(ids(q.drainForBeacon())).toEqual(["c", "d", "e", "f"]);

    const a = pt("a");
    const b = pt("b");
    q.enqueue(a);
    q.enqueue(b);
    const p = q.flush();
    await flushMicrotasks();
    expect(ids(calls[0]!.points)).toEqual(["a", "b"]);
    for (const id of ["c", "d", "e", "f"]) q.enqueue(pt(id));
    // a, b are pinned; the oldest of the rest (c, d) go.
    expect(q.stats().queued).toBe(4);
    expect(ids(q.drainForBeacon())).toEqual(["e", "f"]);
    calls[0]!.resolve();
    await p;
    expect(q.stats()).toMatchObject({ queued: 0, sent: 2 });
  });

  it("debounces: immediate points go now, others wait for flushAt or minFlushMs since the oldest", async () => {
    const { q, send, clock } = make({ flushAt: 3, minFlushMs: 8_000 });
    q.enqueue(pt("first"), { immediate: true });
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);

    const { q: q2, send: send2, calls: calls2, clock: clock2 } = make({ flushAt: 3, minFlushMs: 8_000 });
    q2.enqueue(pt("a"));
    await clock2.advance(3_000);
    q2.enqueue(pt("b"));
    await clock2.advance(4_000);
    expect(send2).not.toHaveBeenCalled();
    await clock2.advance(1_000); // 8 s after "a"
    expect(send2).toHaveBeenCalledTimes(1);
    expect(ids(calls2[0]!.points)).toEqual(["a", "b"]);
    calls2[0]!.resolve();
    await flushMicrotasks();

    q2.enqueue(pt("c"));
    q2.enqueue(pt("d"));
    expect(send2).toHaveBeenCalledTimes(1);
    q2.enqueue(pt("e")); // reaches flushAt
    await flushMicrotasks();
    expect(send2).toHaveBeenCalledTimes(2);
    expect(ids(calls2[1]!.points)).toEqual(["c", "d", "e"]);
    expect(clock.pending()).toBe(0);
  });

  it("clear() drops everything, including the in-flight batch, without counting it as sent or retrying", async () => {
    const { q, calls, clock } = make();
    q.enqueue(pt("a"));
    const p = q.flush();
    await flushMicrotasks();
    q.enqueue(pt("b"));
    q.clear();
    expect(q.stats().queued).toBe(0);
    calls[0]!.resolve();
    await p;
    expect(q.stats()).toMatchObject({ queued: 0, sent: 0, failures: 0 });
    expect(clock.pending()).toBe(0);

    // A failure after clear() schedules no retry either.
    q.enqueue(pt("c"));
    const p2 = q.flush();
    await flushMicrotasks();
    q.clear();
    calls[1]!.reject(new Error("refused"));
    await p2;
    expect(q.stats().nextRetryAt).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("reports stats through onChange", async () => {
    const onChange = vi.fn();
    const { q, calls } = make({ onChange });
    q.enqueue(pt("a"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ queued: 1, sent: 0 }));
    const p = q.flush();
    await flushMicrotasks();
    calls[0]!.resolve();
    await p;
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ queued: 0, sent: 1, inFlight: 0 }));
  });
});

describe("isIgnorableChange", () => {
  const base = { id: "t1", status: "departed", last_lat: 6.68, last_lng: -1.57, last_heading: 10, last_speed_mps: 5, last_location_at: "2026-10-26T06:00:00Z" };
  it("skips an update that touched only the location columns", () => {
    const next = { ...base, last_lat: 6.681, last_location_at: "2026-10-26T06:00:15Z" };
    expect(isIgnorableChange(base, next, TRIP_LOCATION_COLUMNS)).toBe(true);
  });
  it("refreshes when any other column changed too", () => {
    const next = { ...base, status: "arrived", last_lat: 6.681 };
    expect(isIgnorableChange(base, next, TRIP_LOCATION_COLUMNS)).toBe(false);
  });
  it("refreshes when the old row is missing or carries only the primary key", () => {
    expect(isIgnorableChange(undefined, { ...base, last_lat: 1 }, TRIP_LOCATION_COLUMNS)).toBe(false);
    expect(isIgnorableChange({ id: "t1" }, { ...base, last_lat: 1 }, TRIP_LOCATION_COLUMNS)).toBe(false);
  });
  it("refreshes when nothing is ignored or nothing differs", () => {
    expect(isIgnorableChange(base, { ...base, last_lat: 1 }, [])).toBe(false);
    expect(isIgnorableChange(base, { ...base }, TRIP_LOCATION_COLUMNS)).toBe(false);
  });
});
