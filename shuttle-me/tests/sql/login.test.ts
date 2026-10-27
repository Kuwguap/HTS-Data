/**
 * record_login_failure() (migration 0010): the atomic wrong-PIN counter behind the
 * 5-per-15-min sign-in lockout. Replaces the app-side select-then-upsert that a burst
 * of parallel requests could out-race.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { as, connect, errorOf, one, resetDb, rows } from "./helpers";

type Attempt = { username: string; failed_count: number; locked_until: Date | null; updated_at: Date };

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

let c: Client;

beforeAll(async () => {
  c = await resetDb();
});

afterAll(async () => {
  await c.end();
});

function fail(cx: Client, username: string, max = MAX_FAILURES, minutes = LOCKOUT_MINUTES): Promise<Attempt> {
  return one<Attempt>(cx, "select * from public.record_login_failure($1, $2, $3)", [username, max, minutes]);
}

function stored(username: string): Promise<Attempt> {
  return one<Attempt>(c, "select * from public.login_attempts where username = $1", [username]);
}

/** ms until the lock lifts, relative to the DB clock (so a slow test machine cannot skew it). */
async function msUntil(lockedUntil: Date): Promise<number> {
  const now = await one<{ now: Date }>(c, "select now() as now");
  return lockedUntil.getTime() - now.now.getTime();
}

describe("record_login_failure", () => {
  it("counts 1..4, locks on the 5th with failed_count 0 and locked_until ~15 min ahead", async () => {
    for (let i = 1; i < MAX_FAILURES; i++) {
      const r = await fail(c, "seq");
      expect(r.failed_count).toBe(i);
      expect(r.locked_until).toBeNull();
    }
    const locked = await fail(c, "seq");
    expect(locked.failed_count).toBe(0);
    expect(locked.locked_until).not.toBeNull();
    const ahead = await msUntil(locked.locked_until!);
    expect(ahead).toBeGreaterThan((LOCKOUT_MINUTES - 1) * 60_000);
    expect(ahead).toBeLessThanOrEqual(LOCKOUT_MINUTES * 60_000);

    const row = await stored("seq");
    expect(row.failed_count).toBe(0);
    expect(row.locked_until!.getTime()).toBe(locked.locked_until!.getTime());
  });

  it("is a no-op while locked (6th call changes nothing)", async () => {
    const before = await stored("seq");
    const sixth = await fail(c, "seq");
    expect(sixth.failed_count).toBe(0);
    expect(sixth.locked_until!.getTime()).toBe(before.locked_until!.getTime());
    const after = await stored("seq");
    expect(after.failed_count).toBe(0);
    expect(after.locked_until!.getTime()).toBe(before.locked_until!.getTime());
  });

  it("starts counting from 1 again once the lock has expired", async () => {
    await c.query("update public.login_attempts set locked_until = now() - interval '1 second' where username = 'seq'");
    const r = await fail(c, "seq");
    expect(r.failed_count).toBe(1);
    expect(r.locked_until).toBeNull();
  });

  it("honours custom thresholds (2 strikes, 1 minute)", async () => {
    expect((await fail(c, "custom", 2, 1)).failed_count).toBe(1);
    const locked = await fail(c, "custom", 2, 1);
    expect(locked.failed_count).toBe(0);
    const ahead = await msUntil(locked.locked_until!);
    expect(ahead).toBeGreaterThan(50_000);
    expect(ahead).toBeLessThanOrEqual(60_000);
    // A threshold of 1 locks on the very first (insert) call.
    const first = await fail(c, "custom_one", 1, 1);
    expect(first.failed_count).toBe(0);
    expect(first.locked_until).not.toBeNull();
  });

  it("40 concurrent calls end locked and are never over-counted", async () => {
    const clients = await Promise.all(Array.from({ length: 40 }, () => connect()));
    try {
      const results = await Promise.all(clients.map((cx) => fail(cx, "storm")));

      const row = await stored("storm");
      expect(row.failed_count).toBe(0);
      expect(row.locked_until).not.toBeNull();
      expect(await msUntil(row.locked_until!)).toBeGreaterThan((LOCKOUT_MINUTES - 1) * 60_000);

      // Exactly MAX_FAILURES - 1 callers saw an unlocked count (1..4, each once);
      // every other caller saw the locked row. Nothing ever exceeds the threshold.
      const unlocked = results.filter((r) => r.locked_until === null).map((r) => r.failed_count);
      expect(unlocked.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      const lockedResults = results.filter((r) => r.locked_until !== null);
      expect(lockedResults).toHaveLength(40 - (MAX_FAILURES - 1));
      for (const r of lockedResults) {
        expect(r.failed_count).toBe(0);
        expect(r.locked_until!.getTime()).toBe(row.locked_until!.getTime());
      }
      for (const r of results) expect(r.failed_count).toBeLessThan(MAX_FAILURES);

      // Still exactly one row for the username.
      expect(await rows(c, "select 1 from public.login_attempts where username = 'storm'")).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((cx) => cx.end()));
    }
  });

  it("is executable by service_role only (revoked from anon and authenticated)", async () => {
    await as(c, { role: "authenticated" }, async (cx) => {
      expect(await errorOf(cx, "select public.record_login_failure('probe')")).toMatch(/permission denied for function record_login_failure/);
    });
    await as(c, { role: "anon" }, async (cx) => {
      expect(await errorOf(cx, "select public.record_login_failure('probe')")).toMatch(/permission denied for function record_login_failure/);
    });
    await as(c, { role: "service_role" }, async (cx) => {
      expect(await errorOf(cx, "select public.record_login_failure('probe')")).toBe("");
    });
    // The impersonated service_role call above ran inside a rolled-back transaction.
    expect(await rows(c, "select 1 from public.login_attempts where username = 'probe'")).toHaveLength(0);
  });
});
