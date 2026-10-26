import { fromPostgresError, ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { MANUAL_TICK_NOTE, tickHealth } from "@/lib/data/admin";
import { drainOutbox } from "@/lib/push/drain";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/admin/tick — last 20 tick runs + derived health. */
export const GET = withHandler(async () => {
  await requireRole("admin");
  const health = await tickHealth(20);
  return ok({ health });
});

/**
 * POST /api/admin/tick — run the minute tick now (run_tick + drain the push outbox).
 * The audit row is tagged "manual" so tick health (which watches the automatic cron)
 * does not count a hand-run tick as proof that pg_cron is alive.
 */
export const POST = withHandler(async () => {
  await requireRole("admin");
  const admin = createAdminClient();
  const startedAt = Date.now();
  const { data: tick, error } = await admin.rpc("run_tick");
  if (error) throw fromPostgresError(error);
  let run = tick;
  if (run) {
    const note = `${run.note ?? ""} ${MANUAL_TICK_NOTE}`.trim();
    const { data: tagged, error: noteError } = await admin.from("tick_runs").update({ note }).eq("id", run.id).select("*").maybeSingle();
    if (noteError) console.error("[admin] could not tag the manual tick:", noteError.message);
    else if (tagged) run = tagged;
  }
  const push = await drainOutbox({ admin, budgetMs: 40_000 });
  return ok({
    tick: run,
    push: { claimed: push.claimed, sent: push.sent, failed: push.failed, skipped: push.skipped, requeued: push.requeued, deliveries: push.deliveries },
    durationMs: Date.now() - startedAt,
  });
});
