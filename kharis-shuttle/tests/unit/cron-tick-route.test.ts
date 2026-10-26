import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { rpc, createAdminClient, drainOutbox } = vi.hoisted(() => {
  const rpc = vi.fn();
  return {
    rpc,
    createAdminClient: vi.fn(() => ({ rpc })),
    drainOutbox: vi.fn(),
  };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/push/drain", () => ({ drainOutbox }));

import { GET, POST, maxDuration } from "@/app/api/cron/tick/route";

const SECRET = "cron-secret-for-tests-0123456789";
const ctx = { params: Promise.resolve({}) };

/** maxDuration minus the 10 s push socket timeout and 2 s safety, before any time passes. */
const FULL_BUDGET_MS = maxDuration * 1000 - 10_000 - 2_000;

const TICK_ROW = {
  id: 1,
  ran_at: "2026-10-27T06:30:00Z",
  now_ts: "2026-10-27T06:30:00Z",
  trips_created: 5,
  daily_enqueued: 0,
  reminders_enqueued: 12,
  nudges_enqueued: 0,
  manifests_enqueued: 0,
  expired_trips: 0,
  expired_requests: 0,
  pushes_sent: 0,
  pushes_failed: 0,
  duration_ms: 20,
  note: null,
};

const DRAIN = { claimed: 12, sent: 10, failed: 0, skipped: 2, gone: 1, requeued: 0, deliveries: 11, batches: 2, durationMs: 300, rows: [] };

function request(method: string, authorization?: string, body?: string, contentType = "application/json") {
  return new Request("http://localhost:3100/api/cron/tick", {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(body !== undefined ? { "content-type": contentType } : {}) },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "BPUBLIC");
  vi.stubEnv("VAPID_PRIVATE_KEY", "PRIVATE");
  vi.stubEnv("PIN_PEPPER", "a-very-long-pepper-value-for-tests");
  vi.stubEnv("CRON_SECRET", SECRET);
  rpc.mockReset();
  createAdminClient.mockClear();
  drainOutbox.mockReset();
  rpc.mockResolvedValue({ data: TICK_ROW, error: null });
  drainOutbox.mockResolvedValue(DRAIN);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/cron/tick", () => {
  it("rejects a missing bearer without touching the database", async () => {
    const res = await POST(request("POST"), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(drainOutbox).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer with the same message", async () => {
    const wrong = await POST(request("POST", "Bearer nope"), ctx);
    const missing = await POST(request("POST"), ctx);
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.message).toBe((await missing.json()).error.message);
    expect(createAdminClient).not.toHaveBeenCalled();

    const basic = await POST(request("POST", `Basic ${SECRET}`), ctx);
    expect(basic.status).toBe(401);
    const prefix = await POST(request("POST", `Bearer ${SECRET}x`), ctx);
    expect(prefix.status).toBe(401);
  });

  it("runs the tick then drains the outbox with the right bearer", async () => {
    const res = await POST(request("POST", `Bearer ${SECRET}`), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("run_tick");
    expect(drainOutbox).toHaveBeenCalledTimes(1);
    const budget = drainOutbox.mock.calls[0]![0].budgetMs as number;
    expect(budget).toBeLessThanOrEqual(FULL_BUDGET_MS);
    expect(budget).toBeGreaterThan(FULL_BUDGET_MS - 1_000);
    expect(drainOutbox.mock.calls[0]![0].admin).toBe(createAdminClient.mock.results[0]!.value);
    // tick before drain
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(drainOutbox.mock.invocationCallOrder[0]!);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tick_ran).toBe(true);
    expect(body.source).toBeNull();
    expect(body.tick).toEqual(TICK_ROW);
    expect(body.push).toMatchObject({ claimed: 12, sent: 10, failed: 0, skipped: 2, gone: 1 });
    expect(body.push.rows).toBeUndefined();
  });

  it("computes the drain budget from the time run_tick used", async () => {
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    rpc.mockImplementation(async () => {
      t += 7_000; // a slow tick
      return { data: TICK_ROW, error: null };
    });
    const res = await POST(request("POST", `Bearer ${SECRET}`), ctx);
    expect(res.status).toBe(200);
    expect(drainOutbox.mock.calls[0]![0].budgetMs).toBe(FULL_BUDGET_MS - 7_000);
    expect((await res.json()).durationMs).toBe(7_000);
  });

  it("never passes a negative budget when the tick ate the whole window", async () => {
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    rpc.mockImplementation(async () => {
      t += maxDuration * 1000;
      return { data: TICK_ROW, error: null };
    });
    await POST(request("POST", `Bearer ${SECRET}`), ctx);
    expect(drainOutbox.mock.calls[0]![0].budgetMs).toBe(0);
  });

  it("skips run_tick when pg_cron says it already ran it, and still drains", async () => {
    const res = await POST(request("POST", `Bearer ${SECRET}`, JSON.stringify({ source: "pg_cron", at: "2026-10-27T06:30:00Z" })), ctx);
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect(drainOutbox).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, source: "pg_cron", tick_ran: false, tick: null, tick_error: null });
    expect(body.push.sent).toBe(10);
  });

  it("runs the tick for other sources, non-JSON bodies and bodies without source", async () => {
    await POST(request("POST", `Bearer ${SECRET}`, JSON.stringify({ source: "cron-job.org" })), ctx);
    await POST(request("POST", `Bearer ${SECRET}`, JSON.stringify({ at: "x" })), ctx);
    await POST(request("POST", `Bearer ${SECRET}`, "not json"), ctx);
    await POST(request("POST", `Bearer ${SECRET}`, JSON.stringify("pg_cron")), ctx);
    await POST(request("POST", `Bearer ${SECRET}`, JSON.stringify({ source: 42 })), ctx);
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(drainOutbox).toHaveBeenCalledTimes(5);
  });

  it("accepts GET too (pg_net / cron-job.org) and always runs the tick there", async () => {
    const res = await GET(request("GET", `bearer ${SECRET}`), ctx);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("run_tick");
    expect((await res.json()).tick_ran).toBe(true);
  });

  it("still drains when run_tick fails, and reports a 500", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "division by zero" } });
    const res = await POST(request("POST", `Bearer ${SECRET}`), ctx);
    expect(res.status).toBe(500);
    expect(drainOutbox).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.error.details.tick_error).toBe("division by zero");
    expect(body.error.details.push.sent).toBe(10);
  });
});
