/**
 * Guards against the drain re-claiming a row it just handed back as `pending` and
 * burning every attempt in one run. The fake below behaves like the SQL *without*
 * the 45 s cooldown (worst case): finish 'pending' makes the row claimable again
 * at once and every claim bumps push_attempts — the drainer alone must cope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db.types";
import type { SendResult } from "@/lib/push/send";

vi.mock("server-only", () => ({}));

const { sendToSubscription } = vi.hoisted(() => ({ sendToSubscription: vi.fn() }));
vi.mock("@/lib/push/send", () => ({ sendToSubscription }));

import { drainOutbox } from "@/lib/push/drain";

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
type NotificationRow = {
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
  push_status: string;
  push_attempts: number;
  push_error: string | null;
  subs: Sub[];
};

function sub(id: string): Sub {
  return { id, endpoint: `https://push.example/${id}`, p256dh: "BPUB", auth: "AUTH" };
}

function notification(id: string, subs: Sub[]): NotificationRow {
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
    push_status: "pending",
    push_attempts: 0,
    push_error: null,
    subs,
  };
}

/** Fake admin backed by a tiny notifications table that really changes state on claim / finish / update. */
function fakeAdmin(rows: NotificationRow[], opts: { returnAttempts?: boolean } = {}) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const returnAttempts = opts.returnAttempts ?? true;
  const claims: string[][] = [];
  const subUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_pending_notifications") {
      const limit = (args.p_limit as number) ?? 100;
      const picked = [...table.values()].filter((r) => r.push_status === "pending" && r.push_attempts < 5).slice(0, limit);
      for (const r of picked) {
        r.push_status = "sending";
        r.push_attempts += 1;
      }
      claims.push(picked.map((r) => r.id));
      return {
        data: picked.map(({ subs, push_status: _s, push_attempts, push_error: _e, ...rest }) => ({
          ...rest,
          ...(returnAttempts ? { push_attempts } : {}),
          subscriptions: subs,
        })),
        error: null,
      };
    }
    if (name === "finish_notification") {
      const r = table.get(args.p_id as string)!;
      r.push_status = args.p_status as string;
      r.push_error = (args.p_error as string) ?? null;
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  function builder(tableName: string) {
    const state: { op: string; patch?: Record<string, unknown>; id?: string; ids: string[] } = { op: "", ids: [] };
    const result = () => {
      if (tableName === "notifications") {
        const r = table.get(state.id!)!;
        if (state.op === "select") return { data: { push_attempts: r.push_attempts, push_error: r.push_error }, error: null };
        if (state.op === "update") {
          Object.assign(r, state.patch);
          return { data: null, error: null };
        }
      }
      if (tableName === "push_subscriptions") {
        if (state.op === "select") return { data: { id: state.id, fail_count: 0 }, error: null };
        if (state.op === "update") {
          subUpdates.push({ id: state.id!, patch: state.patch! });
          return { data: null, error: null };
        }
        if (state.op === "delete") return { data: null, error: null };
      }
      throw new Error(`unexpected ${state.op} on ${tableName}`);
    };
    const api = {
      select: () => ((state.op = "select"), api),
      update: (patch: Record<string, unknown>) => ((state.op = "update"), (state.patch = patch), api),
      delete: () => ((state.op = "delete"), api),
      eq: (_c: string, id: string) => ((state.id = id), api),
      in: (_c: string, ids: string[]) => ((state.ids = ids), api),
      maybeSingle: async () => result(),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve().then(result).then(resolve, reject),
    };
    return api;
  }

  const admin = { rpc, from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient<Database>;
  return { admin, table, claims, subUpdates };
}

const OK: SendResult = { ok: true, status: 201 };
const RETRY: SendResult = { ok: false, status: 429, gone: false, retryable: true, error: "429 busy" };

beforeEach(() => {
  sendToSubscription.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("drainOutbox does not re-send rows it handed back in the same run", () => {
  it("sends a 429 row exactly once and leaves it pending with push_attempts 1", async () => {
    sendToSubscription.mockResolvedValue(RETRY);
    const fake = fakeAdmin([notification("X", [sub("x1")])]);

    const result = await drainOutbox({ admin: fake.admin });

    expect(sendToSubscription).toHaveBeenCalledTimes(1);
    const x = fake.table.get("X")!;
    expect(x.push_status).toBe("pending");
    expect(x.push_attempts).toBe(1);
    // the re-serve hand-back keeps the useful error from the real attempt
    expect(x.push_error).toBe("attempt 1: 429 retry");
    // claim 1 sent it; claim 2 re-served it and the loop stopped (nothing new in it)
    expect(fake.claims).toEqual([["X"], ["X"]]);
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 0, requeued: 1, reserved: 1, batches: 2 });
    expect(result.rows.map((r) => r.error)).toEqual(["429 retry"]);
    // the device did fail once, and only once
    expect(fake.subUpdates).toEqual([{ id: "x1", patch: { fail_count: 1 } }]);
  });

  it("same outcome when the claim does not return push_attempts (reads the table instead)", async () => {
    sendToSubscription.mockResolvedValue(RETRY);
    const fake = fakeAdmin([notification("X", [sub("x1")])], { returnAttempts: false });
    await drainOutbox({ admin: fake.admin });
    expect(sendToSubscription).toHaveBeenCalledTimes(1);
    expect(fake.table.get("X")).toMatchObject({ push_status: "pending", push_attempts: 1 });
  });

  it("keeps processing fresh rows that arrive while a handed-back row is re-served", async () => {
    sendToSubscription.mockImplementation(async (s: Sub) => (s.id === "x1" ? RETRY : OK));
    const fake = fakeAdmin([notification("X", [sub("x1")])]);
    // A new row lands in the outbox between claim 1 and claim 2 (an app event).
    let injected = false;
    type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
    const rpc = fake.admin.rpc as unknown as ReturnType<typeof vi.fn<Rpc>>;
    const original = rpc.getMockImplementation() as Rpc;
    rpc.mockImplementation(async (name, args) => {
      if (name === "claim_pending_notifications" && fake.claims.length === 1 && !injected) {
        injected = true;
        fake.table.set("Y", notification("Y", [sub("y1")]));
      }
      return original(name, args);
    });

    const result = await drainOutbox({ admin: fake.admin, limit: 10 });

    expect(fake.claims).toEqual([["X"], ["X", "Y"], ["X"]]);
    expect(sendToSubscription).toHaveBeenCalledTimes(2); // X once, Y once
    expect(fake.table.get("X")).toMatchObject({ push_status: "pending", push_attempts: 1, push_error: "attempt 1: 429 retry" });
    expect(fake.table.get("Y")).toMatchObject({ push_status: "sent", push_attempts: 1 });
    expect(result).toMatchObject({ claimed: 2, sent: 1, requeued: 1, reserved: 2, batches: 3 });
    expect(result.rows.map((r) => r.id).sort()).toEqual(["X", "Y"]);
  });

  it("a row that keeps failing needs five separate runs before it is given up on", async () => {
    sendToSubscription.mockResolvedValue(RETRY);
    const fake = fakeAdmin([notification("X", [sub("x1")])]);
    for (let run = 1; run <= 4; run++) {
      await drainOutbox({ admin: fake.admin });
      expect(fake.table.get("X")).toMatchObject({ push_status: "pending", push_attempts: run });
    }
    await drainOutbox({ admin: fake.admin });
    expect(fake.table.get("X")).toMatchObject({ push_status: "failed", push_attempts: 5 });
    expect(sendToSubscription).toHaveBeenCalledTimes(5);
  });
});
