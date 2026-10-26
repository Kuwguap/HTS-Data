/**
 * Outbox drain: claims pending `notifications` rows (claim_pending_notifications),
 * pushes each one to the recipient's active subscriptions and records the outcome
 * (finish_notification). Safe to run from several places at once — the claim is
 * `for update skip locked`, so the minute tick and an `after()` drain never fight.
 *
 * Attempt accounting: the claim bumps `push_attempts` and returns the bumped value.
 * A row only "spends" that attempt when we actually tried to deliver it. Rows we hand
 * back untouched (budget spent, claimed twice in one run, VAPID misconfiguration) get
 * the attempt refunded (`handBack`), so a row can never fail without 5 real tries.
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
  /** Rows taken from the outbox this run (a row claimed twice counts once). */
  claimed: number;
  /** Rows delivered to at least one device. */
  sent: number;
  /** Rows given up on (no device accepted it and no retry is left). */
  failed: number;
  /** Rows with nothing to send to (no active subscription, or every one was gone). */
  skipped: number;
  /** Subscriptions the push service reported as gone (404/410) and we deleted. */
  gone: number;
  /** Rows put back to `pending` for another attempt (including rows handed back unsent). */
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

/**
 * 401/403 (or no VAPID keys at all) means *our* signing keys are wrong, not that the
 * device is bad: the subscription keeps its fail_count and the row stays retryable
 * so it goes out once the keys are fixed.
 */
export function isVapidRejection(r: SendResult): boolean {
  if (r.ok) return false;
  if (r.status === 401 || r.status === 403) return true;
  return r.status === 0 && /vapid/i.test(r.error);
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

/**
 * Per-subscription serialiser: every fail_count read-modify-write (and the reset on
 * success) for one subscription id runs after the previous one for that id finished,
 * so two rows for the same person in one run cannot lose an increment. Cross-process
 * races remain (two drains at once) — acceptable; the SQL-side fix is noted in README.
 */
type SubscriptionLedger = {
  chains: Map<string, Promise<void>>;
  /** fail_count values this run has read or written, so a chained bump needs no re-read. */
  failCounts: Map<string, number>;
};

function serialisePerId(ledger: SubscriptionLedger, id: string, fn: () => Promise<void>): Promise<void> {
  const prev = ledger.chains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  ledger.chains.set(id, next);
  return next;
}

async function markSuccess(admin: Admin, ledger: SubscriptionLedger, ids: string[], nowIso: string): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      serialisePerId(ledger, id, async () => {
        const { error } = await admin
          .from("push_subscriptions")
          .update({ last_success_at: nowIso, fail_count: 0 })
          .eq("id", id);
        if (error) console.error("[push] could not record subscription success:", error.message);
        else ledger.failCounts.set(id, 0);
      }),
    ),
  );
}

/** fail_count + 1 for each; disabled once it reaches SUBSCRIPTION_FAIL_LIMIT. */
async function markFailure(admin: Admin, ledger: SubscriptionLedger, ids: string[], nowIso: string): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      serialisePerId(ledger, id, async () => {
        let current = ledger.failCounts.get(id);
        if (current === undefined) {
          const { data, error } = await admin.from("push_subscriptions").select("id, fail_count").eq("id", id).maybeSingle();
          if (error) {
            console.error("[push] could not read subscription fail count:", error.message);
            return;
          }
          if (!data) return; // deleted meanwhile (gone on another row)
          current = data.fail_count ?? 0;
        }
        const failCount = current + 1;
        const { error: err } = await admin
          .from("push_subscriptions")
          .update({
            fail_count: failCount,
            ...(failCount >= SUBSCRIPTION_FAIL_LIMIT ? { disabled_at: nowIso } : {}),
          })
          .eq("id", id);
        if (err) console.error("[push] could not bump subscription fail count:", err.message);
        else ledger.failCounts.set(id, failCount);
      }),
    ),
  );
}

/** The row's push_attempts after the claim bumped it; null when unknown. */
async function attemptsOf(admin: Admin, row: ClaimedRow): Promise<number | null> {
  if (typeof row.push_attempts === "number") return row.push_attempts;
  const { data, error } = await admin.from("notifications").select("push_attempts").eq("id", row.id).maybeSingle();
  if (error) {
    console.error(`[push] could not read push_attempts for ${row.id}:`, error.message);
    return null;
  }
  return typeof data?.push_attempts === "number" ? data.push_attempts : null;
}

/**
 * Put a row back to `pending` without spending the attempt the claim charged for it
 * (nothing was sent). Leaves push_claimed_at alone: claim_pending_notifications()
 * ignores the row for its cooldown, so the next run picks it up, not this one.
 */
async function handBack(admin: Admin, row: ClaimedRow, reason: string): Promise<void> {
  const attempts = await attemptsOf(admin, row);
  const { error } = await admin
    .from("notifications")
    .update({
      push_status: "pending",
      push_error: reason.slice(0, 500),
      ...(attempts === null ? {} : { push_attempts: Math.max(0, attempts - 1) }),
    })
    .eq("id", row.id);
  if (error) {
    console.error(`[push] could not hand back ${row.id}:`, error.message);
    // Last resort: at least stop it sitting in `sending` for two minutes.
    await finish(admin, row.id, "pending", reason);
  }
}

type RowContext = {
  admin: Admin;
  send: <T>(fn: () => Promise<T>) => Promise<T>;
  result: DrainResult;
  now: () => number;
  ledger: SubscriptionLedger;
};

function recordHandBack(result: DrainResult, id: string, reason: string, subscriptions = 0): void {
  result.requeued++;
  result.rows.push({ id, status: "pending", delivered: 0, subscriptions, error: reason });
}

async function processRow(row: ClaimedRow, ctx: RowContext): Promise<void> {
  const { admin, result, ledger } = ctx;
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
  let vapidRejected = false;
  sends.forEach((r, i) => {
    const sub = subs[i]!;
    if (r.ok) okIds.push(sub.id);
    else if (r.gone) goneIds.push(sub.id);
    else if (isVapidRejection(r)) vapidRejected = true; // our keys, not the device: no fail_count
    else {
      failedIds.push(sub.id);
      if (r.retryable) retryable = true;
    }
  });

  await deleteSubscriptions(admin, goneIds);
  result.gone += goneIds.length;
  await markSuccess(admin, ledger, okIds, nowIso);
  await markFailure(admin, ledger, failedIds, nowIso);
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
  if (vapidRejected) {
    // Misconfigured VAPID keys: keep the row pending (attempt refunded) until the keys are fixed.
    await handBack(admin, row, `vapid rejected (${summary})`);
    recordHandBack(result, row.id, summary, subs.length);
    return;
  }
  if (retryable) {
    const attempts = (await attemptsOf(admin, row)) ?? MAX_PUSH_ATTEMPTS;
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
  const ctx: RowContext = { admin, send, result, now, ledger: { chains: new Map(), failCounts: new Map() } };

  /** Ids this run already took, so a row handed back as `pending` is never re-sent by the same run. */
  const seen = new Set<string>();

  while (elapsed() < budgetMs || result.batches === 0) {
    const { data, error } = await admin.rpc("claim_pending_notifications", { p_limit: limit });
    result.batches++;
    if (error) {
      console.error("[push] claim_pending_notifications failed:", error.message);
      break;
    }
    const rows = (data ?? []) as ClaimedRow[];
    if (rows.length === 0) break;

    const fresh: ClaimedRow[] = [];
    const repeats: ClaimedRow[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) repeats.push(row);
      else {
        seen.add(row.id);
        fresh.push(row);
      }
    }
    // A re-served row is handed back untouched (attempt refunded); it waits for the next run.
    await Promise.all(
      repeats.map((row) =>
        rowLimit(async () => {
          await handBack(admin, row, "already handled in this run");
          recordHandBack(result, row.id, "reclaimed");
        }),
      ),
    );
    if (fresh.length === 0) break; // the outbox only has rows this run already dealt with
    result.claimed += fresh.length;

    await Promise.all(
      fresh.map((row) =>
        rowLimit(async () => {
          if (elapsed() >= budgetMs) {
            // Out of time: hand the row straight back (attempt refunded) instead of leaving it `sending`.
            await handBack(admin, row, "drain budget exhausted");
            recordHandBack(result, row.id, "budget");
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
