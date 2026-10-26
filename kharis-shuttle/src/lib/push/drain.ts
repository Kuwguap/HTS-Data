/**
 * Outbox drain: claims pending `notifications` rows (claim_pending_notifications),
 * pushes each one to the recipient's active subscriptions and records the outcome
 * (finish_notification). Safe to run from several places at once — the claim is
 * `for update skip locked`, so the minute tick and an `after()` drain never fight.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedSubscription, Database, FunctionReturns, PushStatus } from "@/lib/db.types";
import { buildPayload, serializePayload } from "./payload";
import { sendToSubscription, type SendResult } from "./send";

type Admin = SupabaseClient<Database>;
type ClaimedRow = FunctionReturns<"claim_pending_notifications">[number] & { push_attempts?: number };

export const MAX_PUSH_ATTEMPTS = 5;
export const SUBSCRIPTION_FAIL_LIMIT = 10;

export type DrainOptions = {
  /** Rows claimed per round trip (default 100). */
  limit?: number;
  /** Stop claiming new batches once this much wall-clock time has passed (default 60 s). */
  budgetMs?: number;
  /** Pushes in flight at once (default 20). */
  concurrency?: number;
  /** Service-role client; created lazily when omitted. */
  admin?: Admin;
  /** Clock, injectable for tests. */
  now?: () => number;
};

export type DrainRowResult = {
  id: string;
  status: PushStatus;
  /** Devices that accepted the push. */
  delivered: number;
  /** Active subscriptions the row was sent to. */
  subscriptions: number;
  error: string | null;
};

export type DrainResult = {
  /** Rows taken from the outbox this run. */
  claimed: number;
  /** Rows delivered to at least one device. */
  sent: number;
  /** Rows given up on (no device accepted it and no retry is left). */
  failed: number;
  /** Rows with nothing to send to (no active subscription, or every one was gone). */
  skipped: number;
  /** Subscriptions the push service reported as gone (404/410) and we deleted. */
  gone: number;
  /** Rows put back to `pending` for another attempt. */
  requeued: number;
  /** Successful device deliveries (a row can count several). */
  deliveries: number;
  /** Claim round trips made. */
  batches: number;
  durationMs: number;
  /** Per-row outcomes (at most limit × batches entries; small). */
  rows: DrainRowResult[];
};

/**
 * Tiny promise concurrency limiter (no dependency): `const run = pLimit(20); await run(() => task())`.
 */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };
  return <T,>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

/** `subscriptions` arrives as jsonb; keep only well-formed entries. */
export function parseSubscriptions(value: unknown): ClaimedSubscription[] {
  if (!Array.isArray(value)) return [];
  const out: ClaimedSubscription[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (
      typeof s.id === "string" &&
      typeof s.endpoint === "string" &&
      typeof s.p256dh === "string" &&
      typeof s.auth === "string" &&
      s.endpoint.length > 0
    ) {
      out.push({ id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth });
    }
  }
  return out;
}

function summarise(results: SendResult[]): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    const key = r.ok ? "ok" : r.gone ? `${r.status} gone` : r.retryable ? `${r.status || "net"} retry` : r.error.slice(0, 60);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join("; ");
}

async function getAdmin(given?: Admin): Promise<Admin> {
  if (given) return given;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

async function finish(admin: Admin, id: string, status: PushStatus, error: string | null): Promise<void> {
  const { error: err } = await admin.rpc("finish_notification", { p_id: id, p_status: status, p_error: error });
  if (err) console.error(`[push] finish_notification(${id}, ${status}) failed:`, err.message);
}

async function deleteSubscriptions(admin: Admin, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await admin.from("push_subscriptions").delete().in("id", ids);
  if (error) console.error("[push] could not delete gone subscriptions:", error.message);
}

async function markSuccess(admin: Admin, ids: string[], nowIso: string): Promise<void> {
  if (!ids.length) return;
  const { error } = await admin
    .from("push_subscriptions")
    .update({ last_success_at: nowIso, fail_count: 0 })
    .in("id", ids);
  if (error) console.error("[push] could not record subscription success:", error.message);
}

/** fail_count + 1 for each; disabled once it reaches SUBSCRIPTION_FAIL_LIMIT. */
async function markFailure(admin: Admin, ids: string[], nowIso: string): Promise<void> {
  if (!ids.length) return;
  const { data, error } = await admin.from("push_subscriptions").select("id, fail_count").in("id", ids);
  if (error) {
    console.error("[push] could not read subscription fail counts:", error.message);
    return;
  }
  await Promise.all(
    (data ?? []).map(async (s) => {
      const failCount = (s.fail_count ?? 0) + 1;
      const { error: err } = await admin
        .from("push_subscriptions")
        .update({
          fail_count: failCount,
          ...(failCount >= SUBSCRIPTION_FAIL_LIMIT ? { disabled_at: nowIso } : {}),
        })
        .eq("id", s.id);
      if (err) console.error("[push] could not bump subscription fail count:", err.message);
    }),
  );
}

async function attemptsOf(admin: Admin, row: ClaimedRow): Promise<number> {
  if (typeof row.push_attempts === "number") return row.push_attempts;
  const { data } = await admin.from("notifications").select("push_attempts").eq("id", row.id).maybeSingle();
  return data?.push_attempts ?? MAX_PUSH_ATTEMPTS;
}

type RowContext = {
  admin: Admin;
  send: <T>(fn: () => Promise<T>) => Promise<T>;
  result: DrainResult;
  now: () => number;
};

async function processRow(row: ClaimedRow, ctx: RowContext): Promise<void> {
  const { admin, result } = ctx;
  const nowIso = new Date(ctx.now()).toISOString();
  const subs = parseSubscriptions(row.subscriptions);

  const record = (status: PushStatus, delivered: number, error: string | null) => {
    result.rows.push({ id: row.id, status, delivered, subscriptions: subs.length, error });
  };

  if (subs.length === 0) {
    await finish(admin, row.id, "skipped", "no active push subscription");
    result.skipped++;
    record("skipped", 0, "no active push subscription");
    return;
  }

  const body = serializePayload(buildPayload(row));
  const sends = await Promise.all(
    subs.map((sub) =>
      ctx.send(() => sendToSubscription(sub, body, { ttl: row.ttl_seconds, urgency: row.urgency })),
    ),
  );

  const okIds: string[] = [];
  const goneIds: string[] = [];
  const failedIds: string[] = [];
  let retryable = false;
  sends.forEach((r, i) => {
    const sub = subs[i]!;
    if (r.ok) okIds.push(sub.id);
    else if (r.gone) goneIds.push(sub.id);
    else {
      failedIds.push(sub.id);
      if (r.retryable) retryable = true;
    }
  });

  await deleteSubscriptions(admin, goneIds);
  result.gone += goneIds.length;
  await markSuccess(admin, okIds, nowIso);
  await markFailure(admin, failedIds, nowIso);
  result.deliveries += okIds.length;

  const summary = summarise(sends);

  if (okIds.length > 0) {
    await finish(admin, row.id, "sent", null);
    result.sent++;
    record("sent", okIds.length, okIds.length < subs.length ? summary : null);
    return;
  }
  if (goneIds.length === subs.length) {
    await finish(admin, row.id, "skipped", `all subscriptions gone (${summary})`);
    result.skipped++;
    record("skipped", 0, summary);
    return;
  }
  if (retryable) {
    const attempts = await attemptsOf(admin, row);
    if (attempts >= MAX_PUSH_ATTEMPTS) {
      await finish(admin, row.id, "failed", `gave up after ${attempts} attempts (${summary})`);
      result.failed++;
      record("failed", 0, summary);
    } else {
      await finish(admin, row.id, "pending", `attempt ${attempts}: ${summary}`);
      result.requeued++;
      record("pending", 0, summary);
    }
    return;
  }
  await finish(admin, row.id, "failed", summary);
  result.failed++;
  record("failed", 0, summary);
}

/**
 * Drain the outbox until it is empty or the time budget is spent.
 * Never throws: every problem is logged and reflected in the counters.
 */
export async function drainOutbox(options: DrainOptions = {}): Promise<DrainResult> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const budgetMs = Math.max(0, options.budgetMs ?? 60_000);
  const concurrency = Math.max(1, options.concurrency ?? 20);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => now() - startedAt;

  const result: DrainResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    requeued: 0,
    deliveries: 0,
    batches: 0,
    durationMs: 0,
    rows: [],
  };

  let admin: Admin;
  try {
    admin = await getAdmin(options.admin);
  } catch (err) {
    console.error("[push] drain could not create the admin client:", err instanceof Error ? err.message : err);
    result.durationMs = elapsed();
    return result;
  }

  const send = pLimit(concurrency);
  const rowLimit = pLimit(concurrency);
  const ctx: RowContext = { admin, send, result, now };

  while (elapsed() < budgetMs || result.batches === 0) {
    const { data, error } = await admin.rpc("claim_pending_notifications", { p_limit: limit });
    result.batches++;
    if (error) {
      console.error("[push] claim_pending_notifications failed:", error.message);
      break;
    }
    const rows = (data ?? []) as ClaimedRow[];
    if (rows.length === 0) break;
    result.claimed += rows.length;

    await Promise.all(
      rows.map((row) =>
        rowLimit(async () => {
          if (elapsed() >= budgetMs) {
            // Out of time: hand the row straight back instead of leaving it `sending` for 2 min.
            await finish(admin, row.id, "pending", "drain budget exhausted");
            result.requeued++;
            result.rows.push({ id: row.id, status: "pending", delivered: 0, subscriptions: 0, error: "budget" });
            return;
          }
          try {
            await processRow(row, ctx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[push] row ${row.id} failed unexpectedly:`, message);
            await finish(admin, row.id, "failed", `drain error: ${message}`.slice(0, 500));
            result.failed++;
            result.rows.push({ id: row.id, status: "failed", delivered: 0, subscriptions: 0, error: message });
          }
        }),
      ),
    );
  }

  result.durationMs = elapsed();
  return result;
}
