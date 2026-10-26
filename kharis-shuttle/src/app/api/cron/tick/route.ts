import { NextResponse } from "next/server";
import { ApiError, fail, withHandler } from "@/lib/api";
import { secretsEqual } from "@/lib/auth/pin";
import { serverEnv } from "@/lib/env";
import { drainOutbox } from "@/lib/push/drain";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The drain stops claiming once its budget is spent, but a push already in flight can still wait this long. */
const SEND_TIMEOUT_MS = 10_000;
/** Headroom for the response itself. */
const SAFETY_MS = 2_000;

/**
 * Whatever is left of maxDuration once run_tick has finished, minus the socket timeout
 * of a push started at the very end and a little safety: the handler must never be
 * killed by the host while rows sit in `sending`.
 */
function drainBudgetMs(elapsedMs: number): number {
  return Math.max(0, maxDuration * 1000 - SEND_TIMEOUT_MS - SAFETY_MS - Math.max(0, elapsedMs));
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

/** `source` from a JSON body (`{"source":"pg_cron"}` from cron_tick()); null for GET, no body or non-JSON. */
async function bodySource(request: Request): Promise<string | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  try {
    const body: unknown = await request.json();
    const source = body && typeof body === "object" ? (body as { source?: unknown }).source : undefined;
    return typeof source === "string" ? source : null;
  } catch {
    return null;
  }
}

/**
 * The minute tick. Called by pg_cron (via pg_net) and, as a backup, by any external
 * cron with `Authorization: Bearer <CRON_SECRET>`:
 *   1. rpc run_tick()   — materialise trips, enqueue reminders/nudges/manifests, expire things
 *                         (skipped when the body says `source: "pg_cron"`: cron_tick() already ran it in SQL)
 *   2. drainOutbox()    — push every pending notification
 * Responds with both sets of counters so an uptime monitor can alert on failures.
 */
const handle = withHandler(async (request: Request) => {
  const { cronSecret } = serverEnv();
  const token = bearerToken(request);
  if (!token || !secretsEqual(token, cronSecret)) {
    return fail(401, "UNAUTHENTICATED", "Unauthorized");
  }

  const startedAt = Date.now();
  const source = await bodySource(request);
  const admin = createAdminClient();

  let tick: unknown = null;
  let tickError: { message: string } | null = null;
  const ranTick = source !== "pg_cron";
  if (ranTick) {
    const res = await admin.rpc("run_tick");
    tick = res.data ?? null;
    tickError = res.error ? { message: res.error.message } : null;
    if (tickError) console.error("[tick] run_tick failed:", tickError.message);
  }

  // Drain even when the tick failed: rows enqueued by the app still need delivering.
  const push = await drainOutbox({ admin, budgetMs: drainBudgetMs(Date.now() - startedAt) });

  const body = {
    ok: !tickError,
    source,
    tick_ran: ranTick,
    tick,
    tick_error: tickError ? tickError.message : null,
    push: {
      claimed: push.claimed,
      sent: push.sent,
      failed: push.failed,
      skipped: push.skipped,
      gone: push.gone,
      requeued: push.requeued,
      deliveries: push.deliveries,
      batches: push.batches,
      durationMs: push.durationMs,
    },
    durationMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  };

  if (tickError) {
    // Surface the failure to monitors without hiding the drain's work.
    throw new ApiError(500, "INTERNAL", "run_tick failed", body);
  }
  return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
});

export const POST = handle;
export const GET = handle;
