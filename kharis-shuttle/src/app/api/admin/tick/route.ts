import { fromPostgresError, ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { tickHealth } from "@/lib/data/admin";
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

/** POST /api/admin/tick — run the minute tick now (run_tick + drain the push outbox). */
export const POST = withHandler(async () => {
  await requireRole("admin");
  const admin = createAdminClient();
  const startedAt = Date.now();
  const { data: tick, error } = await admin.rpc("run_tick");
  if (error) throw fromPostgresError(error);
  const push = await drainOutbox({ admin, budgetMs: 40_000 });
  return ok({
    tick,
    push: { claimed: push.claimed, sent: push.sent, failed: push.failed, skipped: push.skipped, requeued: push.requeued, deliveries: push.deliveries },
    durationMs: Date.now() - startedAt,
  });
});
