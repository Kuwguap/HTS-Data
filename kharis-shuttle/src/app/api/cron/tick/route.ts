import { NextResponse } from "next/server";
import { ApiError, fail, withHandler } from "@/lib/api";
import { secretsEqual } from "@/lib/auth/pin";
import { serverEnv } from "@/lib/env";
import { drainOutbox } from "@/lib/push/drain";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Budget for the drain: the whole handler must finish inside maxDuration. */
const DRAIN_BUDGET_MS = 55_000;

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

/**
 * The minute tick. Called by pg_cron (via pg_net) and, as a backup, by any external
 * cron with `Authorization: Bearer <CRON_SECRET>`:
 *   1. rpc run_tick()   — materialise trips, enqueue reminders/nudges/manifests, expire things
 *   2. drainOutbox()    — push every pending notification
 * Responds with both sets of counters so an uptime monitor can alert on failures.
 */
const handle = withHandler(async (request: Request) => {
  const { cronSecret } = serverEnv();
  const token = bearerToken(request);
  if (!token || !secretsEqual(token, cronSecret)) {
    return fail(401, "UNAUTHENTICATED", "Unauthorized");
  }

  const admin = createAdminClient();
  const startedAt = Date.now();

  const { data: tick, error: tickError } = await admin.rpc("run_tick");
  if (tickError) console.error("[tick] run_tick failed:", tickError.message);

  // Drain even when the tick failed: rows enqueued by the app still need delivering.
  const push = await drainOutbox({ admin, budgetMs: DRAIN_BUDGET_MS });

  const body = {
    ok: !tickError,
    tick: tick ?? null,
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
