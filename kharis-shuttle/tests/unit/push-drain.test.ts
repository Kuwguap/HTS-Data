import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db.types";
import type { SendResult } from "@/lib/push/send";

vi.mock("server-only", () => ({}));

const { sendToSubscription } = vi.hoisted(() => ({ sendToSubscription: vi.fn() }));
vi.mock("@/lib/push/send", () => ({ sendToSubscription }));

import {
  MAX_PUSH_ATTEMPTS,
  MAX_VAPID_HANDBACKS,
  SUBSCRIPTION_FAIL_LIMIT,
  drainOutbox,
  isVapidRejection,
  pLimit,
  parseSubscriptions,
  vapidHandBacks,
} from "@/lib/push/drain";

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
type Row = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown>;
  ttl_seconds: number;
  urgency: string;
  collapse_tag: string | null;
  subscriptions: Sub[];
  push_attempts?: number;
};

function sub(id: string): Sub {
  return { id, endpoint: `https://push.example/${id}`, p256dh: "BPUB", auth: "AUTH" };
}

function row(id: string, subs: Sub[], extra: Partial<Row> = {}): Row {
  return {
    id,
    user_id: `user-${id}`,
    kind: "trip_reminder",
    title: `Title ${id}`,
    body: "Body",
    url: "/app",
    data: {},
    ttl_seconds: 600,
    urgency: "normal",
    collapse_tag: null,
    subscriptions: subs,
    ...extra,
  };
}

/**
 * A scripted stand-in for the service-role client: `rpc` answers from the batches
 * list, `from()` records writes against in-memory subscriptions / notifications tables.
 */
function fakeAdmin(
  batches: Row[][],
  opts: { attempts?: Record<string, number>; failCounts?: Record<string, number>; errors?: Record<string, string> } = {},
) {
  const finished: Array<{ id: string; status: string; error: string | null }> = [];
  const deletedSubs: string[] = [];
  const subUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const notificationUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const failCounts: Record<string, number> = { ...opts.failCounts };
  const attempts: Record<string, number> = { ...opts.attempts };
  /** push_error per notification id, as the table would hold it. */
  const errors: Record<string, string | null> = { ...opts.errors };
  const queue = [...batches];
  let claims = 0;

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_pending_notifications") {
      claims++;
      return { data: queue.shift() ?? [], error: null };
    }
    if (name === "finish_notification") {
      finished.push({ id: args.p_id as string, status: args.p_status as string, error: (args.p_error as string) ?? null });
      errors[args.p_id as string] = args.p_status === "sent" ? null : ((args.p_error as string) ?? null);
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  function builder(table: string) {
    const state: { op: string; patch?: Record<string, unknown>; ids: string[]; id?: string; columns?: string } = { op: "", ids: [] };
    const targets = () => (state.id ? [state.id] : state.ids);
    const result = () => {
      if (table === "push_subscriptions") {
        if (state.op === "delete") {
          deletedSubs.push(...targets());
          return { data: null, error: null };
        }
        if (state.op === "update") {
          for (const id of targets()) {
            subUpdates.push({ id, patch: state.patch! });
            if (typeof state.patch!.fail_count === "number") failCounts[id] = state.patch!.fail_count as number;
          }
          return { data: null, error: null };
        }
        if (state.op === "select") {
          const rows = targets().map((id) => ({ id, fail_count: failCounts[id] ?? 0 }));
          return { data: state.id ? (rows[0] ?? null) : rows, error: null };
        }
      }
      if (table === "notifications") {
        if (state.op === "select") {
          return { data: { push_attempts: attempts[state.id!] ?? 1, push_error: errors[state.id!] ?? null }, error: null };
        }
        if (state.op === "update") {
          for (const id of targets()) {
            notificationUpdates.push({ id, patch: state.patch! });
            if (typeof state.patch!.push_attempts === "number") attempts[id] = state.patch!.push_attempts as number;
            if (typeof state.patch!.push_error === "string") errors[id] = state.patch!.push_error as string;
          }
          return { data: null, error: null };
        }
      }
      throw new Error(`unexpected ${state.op} on ${table}`);
    };
    const api = {
      select: (columns: string) => ((state.op = "select"), (state.columns = columns), api),
      delete: () => ((state.op = "delete"), api),
      update: (patch: Record<string, unknown>) => ((state.op = "update"), (state.patch = patch), api),
      in: (_col: string, ids: string[]) => ((state.ids = ids), api),
      eq: (_col: string, id: string) => ((state.id = id), api),
      maybeSingle: async () => result(),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve().then(result).then(resolve, reject),
    };
    return api;
  }

  const admin = { rpc, from: vi.fn((table: string) => builder(table)) } as unknown as SupabaseClient<Database>;
  return {
    admin,
    finished,
    deletedSubs,
    subUpdates,
    notificationUpdates,
    failCounts,
    attempts,
    errors,
    get claims() {
      return claims;
    },
  };
}

const OK: SendResult = { ok: true, status: 201 };
const GONE: SendResult = { ok: false, status: 410, gone: true, retryable: false, error: "410 gone" };
const RETRY: SendResult = { ok: false, status: 429, gone: false, retryable: true, error: "429 busy" };
const PERM: SendResult = { ok: false, status: 400, gone: false, retryable: false, error: "400 bad request" };
const VAPID: SendResult = { ok: false, status: 403, gone: false, retryable: false, error: "403 vapid rejected" };

/** Script send results per subscription id. */
function scriptSends(script: Record<string, SendResult | (() => Promise<SendResult>)>) {
  sendToSubscription.mockImplementation(async (s: Sub) => {
    const r = script[s.id];
    if (!r) throw new Error(`no script for ${s.id}`);
    return typeof r === "function" ? r() : r;
  });
}

beforeEach(() => {
  sendToSubscription.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("drainOutbox", () => {
  it("finishes every row with the right status and prunes gone subscriptions", async () => {
    const batches: Row[][] = [
      [
        row("A", [sub("a1")]), // delivered
        row("B", []), // nobody to send to
        row("C", [sub("c1"), sub("c2")]), // both gone
        row("D", [sub("d1")]), // 429 on attempt 1 → retry
      ],
      [
        row("E", [sub("e1")]), // 429 on the 5th attempt → failed
        row("F", [sub("f1")]), // 400 → failed for good
        row("G", [sub("g1"), sub("g2")]), // one ok, one gone → sent + pruned
      ],
    ];
    scriptSends({ a1: OK, c1: GONE, c2: GONE, d1: RETRY, e1: RETRY, f1: PERM, g1: OK, g2: GONE });
    const fake = fakeAdmin(batches, { attempts: { D: 1, E: MAX_PUSH_ATTEMPTS } });

    const result = await drainOutbox({ admin: fake.admin, limit: 4 });

    expect(result).toMatchObject({ claimed: 7, sent: 2, failed: 2, skipped: 2, gone: 3, requeued: 1, reserved: 0, deliveries: 2, batches: 3 });
    expect(fake.claims).toBe(3); // two batches + the empty one that ends the loop
    expect(fake.admin.rpc).toHaveBeenCalledWith("claim_pending_notifications", { p_limit: 4 });

    const statusOf = Object.fromEntries(fake.finished.map((f) => [f.id, f.status]));
    expect(statusOf).toEqual({ A: "sent", B: "skipped", C: "skipped", D: "pending", E: "failed", F: "failed", G: "sent" });
    expect(fake.finished.find((f) => f.id === "B")?.error).toMatch(/no active/);
    expect(fake.finished.find((f) => f.id === "E")?.error).toMatch(/gave up/);
    expect(fake.deletedSubs.sort()).toEqual(["c1", "c2", "g2"]);
    expect(fake.notificationUpdates).toEqual([]); // nothing handed back unsent

    // success resets fail_count; failures bump it
    expect(fake.subUpdates.find((u) => u.id === "a1")?.patch).toMatchObject({ fail_count: 0 });
    expect(fake.subUpdates.find((u) => u.id === "d1")?.patch).toMatchObject({ fail_count: 1 });
    expect(fake.subUpdates.find((u) => u.id === "f1")?.patch).toMatchObject({ fail_count: 1 });
    expect(fake.subUpdates.find((u) => u.id === "f1")?.patch.disabled_at).toBeUndefined();

    expect(result.rows.find((r) => r.id === "G")).toMatchObject({ status: "sent", delivered: 1, subscriptions: 2 });
    expect(sendToSubscription).toHaveBeenCalledTimes(8);
    expect(sendToSubscription.mock.calls[0]![2]).toEqual({ ttl: 600, urgency: "normal" });
  });

  it("disables a subscription once fail_count reaches the limit", async () => {
    scriptSends({ x1: PERM });
    const fake = fakeAdmin([[row("X", [sub("x1")])]], { failCounts: { x1: SUBSCRIPTION_FAIL_LIMIT - 1 } });
    await drainOutbox({ admin: fake.admin });
    const patch = fake.subUpdates.find((u) => u.id === "x1")?.patch;
    expect(patch?.fail_count).toBe(SUBSCRIPTION_FAIL_LIMIT);
    expect(typeof patch?.disabled_at).toBe("string");
  });

  it("serialises fail_count bumps per subscription within a run (no lost increments)", async () => {
    scriptSends({ shared: PERM });
    // Five rows for the same person, one device: concurrent read-modify-writes must still reach 5.
    const rows = ["P1", "P2", "P3", "P4", "P5"].map((id) => row(id, [sub("shared")]));
    const fake = fakeAdmin([rows]);
    const result = await drainOutbox({ admin: fake.admin, concurrency: 20 });
    expect(result.failed).toBe(5);
    expect(fake.failCounts.shared).toBe(5);
    const bumps = fake.subUpdates.filter((u) => u.id === "shared").map((u) => u.patch.fail_count);
    expect(bumps).toEqual([1, 2, 3, 4, 5]);
    // read once, then the run's own ledger feeds the next increments
    const reads = (fake.admin.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "push_subscriptions").length;
    expect(reads).toBe(6); // 1 select + 5 updates
  });

  it("a success after a failure in the same run resets fail_count in order", async () => {
    let calls = 0;
    sendToSubscription.mockImplementation(async () => (calls++ === 0 ? PERM : OK));
    const fake = fakeAdmin([[row("Q1", [sub("q")]), row("Q2", [sub("q")])]]);
    await drainOutbox({ admin: fake.admin, concurrency: 1 });
    const bumps = fake.subUpdates.filter((u) => u.id === "q").map((u) => u.patch.fail_count);
    expect(bumps).toEqual([1, 0]);
    expect(fake.failCounts.q).toBe(0);
  });

  describe("VAPID misconfiguration (401/403)", () => {
    it("hands the row back pending without touching the subscription or spending an attempt", async () => {
      scriptSends({ v1: VAPID });
      const fake = fakeAdmin([[{ ...row("V", [sub("v1")]), push_attempts: 1 }]]);
      const result = await drainOutbox({ admin: fake.admin });

      expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 0, requeued: 1 });
      expect(fake.subUpdates).toEqual([]); // fail_count untouched, nothing disabled
      expect(fake.deletedSubs).toEqual([]);
      expect(fake.finished).toEqual([]); // not finish_notification: the attempt is refunded by a direct update
      expect(fake.notificationUpdates).toEqual([
        { id: "V", patch: expect.objectContaining({ push_status: "pending", push_attempts: 0 }) },
      ]);
      expect(fake.notificationUpdates[0]!.patch.push_error).toBe("vapid-misconfig x1 (403 vapid rejected)");
      expect(result.rows[0]).toMatchObject({ id: "V", status: "pending", delivered: 0 });
    });

    it("401 and a missing key pair count the same (every device rejected our keys → handed back)", async () => {
      scriptSends({
        w1: { ok: false, status: 401, gone: false, retryable: false, error: "401 vapid rejected" },
        w2: { ok: false, status: 0, gone: false, retryable: false, error: "vapid not configured" },
      });
      const fake = fakeAdmin([[{ ...row("W", [sub("w1"), sub("w2")]), push_attempts: 3 }]]);
      await drainOutbox({ admin: fake.admin });
      expect(fake.notificationUpdates).toEqual([{ id: "W", patch: expect.objectContaining({ push_status: "pending", push_attempts: 2 }) }]);
      expect(fake.subUpdates).toEqual([]);
      expect(fake.finished).toEqual([]);
    });

    it("a mix of 403 and 429 is an ordinary attempt: the row is retried via finish_notification and the VAPID device is not blamed", async () => {
      scriptSends({ w1: VAPID, w3: RETRY });
      const fake = fakeAdmin([[{ ...row("W", [sub("w1"), sub("w3")]), push_attempts: 3 }]]);
      const result = await drainOutbox({ admin: fake.admin });
      expect(fake.notificationUpdates).toEqual([]); // no refund
      expect(fake.finished).toEqual([{ id: "W", status: "pending", error: expect.stringMatching(/^attempt 3: /) }]);
      expect(result).toMatchObject({ requeued: 1, failed: 0 });
      // only the 429 device is a device-side failure; w1 keeps its fail_count
      expect(fake.subUpdates.map((u) => u.id)).toEqual(["w3"]);
    });

    it("a mixed row on its last attempt fails like any other, without disabling the VAPID-rejected device", async () => {
      scriptSends({ x1: VAPID, x2: RETRY });
      const fake = fakeAdmin([[{ ...row("X", [sub("x1"), sub("x2")]), push_attempts: MAX_PUSH_ATTEMPTS }]], {
        failCounts: { x1: SUBSCRIPTION_FAIL_LIMIT - 1, x2: 0 },
      });
      const result = await drainOutbox({ admin: fake.admin });
      expect(result).toMatchObject({ failed: 1, requeued: 0 });
      expect(fake.finished).toEqual([{ id: "X", status: "failed", error: expect.stringMatching(/gave up/) }]);
      expect(fake.subUpdates.map((u) => u.id)).toEqual(["x2"]);
      expect(fake.failCounts.x1).toBe(SUBSCRIPTION_FAIL_LIMIT - 1); // healthy device untouched
    });

    it("a mix of 403 and a permanent device error fails the row (a real try happened)", async () => {
      scriptSends({ p1: VAPID, p2: PERM });
      const fake = fakeAdmin([[{ ...row("P", [sub("p1"), sub("p2")]), push_attempts: 1 }]]);
      const result = await drainOutbox({ admin: fake.admin });
      expect(result).toMatchObject({ failed: 1, requeued: 0 });
      expect(fake.notificationUpdates).toEqual([]);
      expect(fake.subUpdates.map((u) => u.id)).toEqual(["p2"]);
    });

    it("gone devices do not stop a hand-back: 410 + 403 is still only our keys at fault", async () => {
      scriptSends({ g1: GONE, g2: VAPID });
      const fake = fakeAdmin([[{ ...row("G", [sub("g1"), sub("g2")]), push_attempts: 1 }]]);
      const result = await drainOutbox({ admin: fake.admin });
      expect(fake.deletedSubs).toEqual(["g1"]);
      expect(result).toMatchObject({ requeued: 1, gone: 1, failed: 0 });
      expect(fake.notificationUpdates).toEqual([{ id: "G", patch: expect.objectContaining({ push_status: "pending", push_attempts: 0 }) }]);
    });

    it("counts hand-backs in push_error and gives up after MAX_VAPID_HANDBACKS", async () => {
      scriptSends({ c1: VAPID });
      const fake = fakeAdmin(
        [[{ ...row("C", [sub("c1")]), push_attempts: 1 }], [{ ...row("D", [sub("c1")]), push_attempts: 1 }]],
        { errors: { C: `vapid-misconfig x${MAX_VAPID_HANDBACKS - 1} (403 vapid rejected)`, D: `vapid-misconfig x${MAX_VAPID_HANDBACKS} (403 vapid rejected)` } },
      );
      const result = await drainOutbox({ admin: fake.admin, limit: 1 });

      // C: one more hand-back is allowed (the 30th)
      expect(fake.notificationUpdates).toEqual([
        { id: "C", patch: { push_status: "pending", push_error: `vapid-misconfig x${MAX_VAPID_HANDBACKS} (403 vapid rejected)`, push_attempts: 0 } },
      ]);
      // D: the 31st is one too many → failed for good, device still untouched
      expect(fake.finished).toEqual([{ id: "D", status: "failed", error: expect.stringMatching(/vapid rejected 31 times/) }]);
      expect(fake.subUpdates).toEqual([]);
      expect(result).toMatchObject({ claimed: 2, requeued: 1, failed: 1 });
    });

    it("an unrelated previous error starts the VAPID count from one", async () => {
      scriptSends({ e1: VAPID });
      const fake = fakeAdmin([[{ ...row("E", [sub("e1")]), push_attempts: 2 }]], { errors: { E: "attempt 1: 429 retry" } });
      await drainOutbox({ admin: fake.admin });
      expect(fake.notificationUpdates[0]!.patch).toMatchObject({ push_error: "vapid-misconfig x1 (403 vapid rejected)", push_attempts: 1 });
    });

    it("reads push_attempts along with push_error when the claim did not return it", async () => {
      scriptSends({ r1: VAPID });
      const fake = fakeAdmin([[row("R", [sub("r1")])]], { attempts: { R: 4 }, errors: { R: "vapid-misconfig x2 (403 vapid rejected)" } });
      await drainOutbox({ admin: fake.admin });
      expect(fake.notificationUpdates).toEqual([
        { id: "R", patch: { push_status: "pending", push_error: "vapid-misconfig x3 (403 vapid rejected)", push_attempts: 3 } },
      ]);
      const reads = (fake.admin.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "notifications").length;
      expect(reads).toBe(2); // one select, one update
    });

    it("vapidHandBacks parses the counter prefix", () => {
      expect(vapidHandBacks(null)).toBe(0);
      expect(vapidHandBacks("")).toBe(0);
      expect(vapidHandBacks("attempt 2: 429 retry")).toBe(0);
      expect(vapidHandBacks("vapid-misconfig x7 (403 vapid rejected)")).toBe(7);
      expect(vapidHandBacks("vapid-misconfig x31")).toBe(31);
      expect(vapidHandBacks("vapid-misconfig xnope")).toBe(0);
    });

    it("still counts as sent when another device accepted it", async () => {
      scriptSends({ y1: VAPID, y2: OK });
      const fake = fakeAdmin([[row("Y", [sub("y1"), sub("y2")])]]);
      const result = await drainOutbox({ admin: fake.admin });
      expect(result.sent).toBe(1);
      expect(fake.finished[0]).toMatchObject({ id: "Y", status: "sent" });
      expect(fake.subUpdates.map((u) => u.id)).toEqual(["y2"]);
    });

    it("isVapidRejection classifies results", () => {
      expect(isVapidRejection(VAPID)).toBe(true);
      expect(isVapidRejection({ ...VAPID, status: 401 })).toBe(true);
      expect(isVapidRejection({ ok: false, status: 0, gone: false, retryable: false, error: "vapid not configured" })).toBe(true);
      expect(isVapidRejection(PERM)).toBe(false);
      expect(isVapidRejection(RETRY)).toBe(false);
      expect(isVapidRejection(GONE)).toBe(false);
      expect(isVapidRejection(OK)).toBe(false);
    });
  });

  it("uses push_attempts from the row when the claim provides it", async () => {
    scriptSends({ y1: RETRY });
    const fake = fakeAdmin([[{ ...row("Y", [sub("y1")]), push_attempts: 5 } as Row]]);
    await drainOutbox({ admin: fake.admin });
    expect(fake.finished[0]).toMatchObject({ id: "Y", status: "failed" });
    expect(fake.admin.from).not.toHaveBeenCalledWith("notifications");
  });

  it("stops claiming once the budget is spent", async () => {
    const slow = () => new Promise<SendResult>((r) => setTimeout(() => r(OK), 40));
    scriptSends({ s1: slow, s2: slow, s3: slow });
    const fake = fakeAdmin([[row("S1", [sub("s1")])], [row("S2", [sub("s2")])], [row("S3", [sub("s3")])]]);
    const result = await drainOutbox({ admin: fake.admin, budgetMs: 20 });
    expect(result.batches).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(20);
  });

  it("does nothing at all when the budget is zero or negative (no claim, nothing hidden behind the cooldown)", async () => {
    const fake = fakeAdmin([[row("B0", [sub("b0")])]]);
    for (const budgetMs of [0, -5]) {
      const result = await drainOutbox({ admin: fake.admin, budgetMs });
      expect(result).toMatchObject({ claimed: 0, batches: 0, requeued: 0, reserved: 0, rows: [] });
    }
    expect(fake.admin.rpc).not.toHaveBeenCalled();
    expect(sendToSubscription).not.toHaveBeenCalled();
    expect(fake.notificationUpdates).toEqual([]);
  });

  it("hands rows back as pending when the budget runs out mid-batch, refunding the attempt", async () => {
    let t = 0;
    const now = () => t;
    scriptSends({
      m1: async () => {
        t += 1_000; // the first send burns the whole budget
        return OK;
      },
      m2: OK,
    });
    const fake = fakeAdmin([[row("M1", [sub("m1")]), { ...row("M2", [sub("m2")]), push_attempts: 2 }]]);
    const result = await drainOutbox({ admin: fake.admin, budgetMs: 500, concurrency: 1, now });
    expect(result.sent).toBe(1);
    expect(result.requeued).toBe(1);
    expect(fake.finished).toEqual([expect.objectContaining({ id: "M1", status: "sent" })]);
    expect(fake.notificationUpdates).toEqual([
      { id: "M2", patch: { push_status: "pending", push_error: "drain budget exhausted", push_attempts: 1 } },
    ]);
    expect(result.rows).toContainEqual({ id: "M2", status: "pending", delivered: 0, subscriptions: 0, error: "budget" });
    expect(sendToSubscription).toHaveBeenCalledTimes(1);
  });

  it("reads push_attempts from the table when the claim did not return it before refunding", async () => {
    let t = 0;
    scriptSends({ n1: async () => ((t += 1_000), OK), n2: OK });
    const fake = fakeAdmin([[row("N1", [sub("n1")]), row("N2", [sub("n2")])]], { attempts: { N2: 4 } });
    await drainOutbox({ admin: fake.admin, budgetMs: 500, concurrency: 1, now: () => t });
    expect(fake.notificationUpdates).toEqual([{ id: "N2", patch: expect.objectContaining({ push_attempts: 3 }) }]);
    expect(fake.attempts.N2).toBe(3);
  });

  it("never drives push_attempts below zero", async () => {
    let t = 0;
    scriptSends({ z1: async () => ((t += 1_000), OK) });
    const fake = fakeAdmin([[row("Z1", [sub("z1")]), { ...row("Z2", []), push_attempts: 0 }]]);
    await drainOutbox({ admin: fake.admin, budgetMs: 500, concurrency: 1, now: () => t });
    expect(fake.notificationUpdates).toEqual([{ id: "Z2", patch: expect.objectContaining({ push_attempts: 0 }) }]);
  });

  it("keeps at most `concurrency` pushes in flight", async () => {
    let active = 0;
    let peak = 0;
    sendToSubscription.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return OK;
    });
    const rows = Array.from({ length: 60 }, (_, i) => row(`R${i}`, [sub(`r${i}a`), sub(`r${i}b`)]));
    const fake = fakeAdmin([rows]);
    const result = await drainOutbox({ admin: fake.admin, concurrency: 20 });
    expect(result.sent).toBe(60);
    expect(result.deliveries).toBe(120);
    expect(sendToSubscription).toHaveBeenCalledTimes(120);
    expect(peak).toBeLessThanOrEqual(20);
    expect(peak).toBeGreaterThan(1);
  });

  it("survives a claim error and a row that throws", async () => {
    sendToSubscription.mockImplementation(async () => {
      throw new Error("boom");
    });
    const fake = fakeAdmin([[row("T", [sub("t1")])]]);
    const result = await drainOutbox({ admin: fake.admin });
    expect(result.failed).toBe(1);
    expect(fake.finished[0]).toMatchObject({ id: "T", status: "failed" });
    expect(fake.finished[0]!.error).toMatch(/boom/);

    const broken = { rpc: vi.fn(async () => ({ data: null, error: { message: "db down" } })), from: vi.fn() } as unknown as SupabaseClient<Database>;
    const r2 = await drainOutbox({ admin: broken });
    expect(r2).toMatchObject({ claimed: 0, batches: 1 });
  });

  it("falls back to finish_notification when the hand-back update fails", async () => {
    let t = 0;
    scriptSends({ h1: async () => ((t += 1_000), OK) });
    const fake = fakeAdmin([[row("H1", [sub("h1")]), { ...row("H2", [sub("h2")]), push_attempts: 1 }]]);
    const realFrom = fake.admin.from as unknown as (table: string) => unknown;
    (fake.admin as unknown as { from: unknown }).from = vi.fn((table: string) =>
      table === "notifications"
        ? { update: () => ({ eq: async () => ({ data: null, error: { message: "update refused" } }) }) }
        : realFrom(table),
    );
    await drainOutbox({ admin: fake.admin, budgetMs: 500, concurrency: 1, now: () => t });
    expect(fake.finished).toContainEqual({ id: "H2", status: "pending", error: "drain budget exhausted" });
  });
});

describe("helpers", () => {
  it("parseSubscriptions drops malformed entries", () => {
    expect(parseSubscriptions(null)).toEqual([]);
    expect(parseSubscriptions("x")).toEqual([]);
    expect(parseSubscriptions([sub("ok"), { id: "bad" }, null, { ...sub("empty"), endpoint: "" }])).toEqual([sub("ok")]);
  });
  it("pLimit bounds concurrency and preserves results / rejections", async () => {
    const run = pLimit(2);
    let active = 0;
    let peak = 0;
    const task = (v: number) =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return v;
      });
    const results = await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    await expect(run(async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    await expect(run(async () => "after")).resolves.toBe("after");
  });
});
