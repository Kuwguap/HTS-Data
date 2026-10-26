import { ok, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { enqueueNotification } from "@/lib/notify/enqueue";
import { drainOutbox } from "@/lib/push/drain";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/push/test — send the caller a "Notifications are on" push right now
 * (onboarding step 2 and the settings screen). Drains inline (not after()) so the
 * response can say how many devices got it.
 */
export const POST = withHandler(async () => {
  const { user, profile } = await requireUser();
  const admin = createAdminClient();

  const { count: devicesBefore } = await admin
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("disabled_at", null);

  const dedupePrefix = `test:${Date.now()}`;
  const enqueued = await enqueueNotification(admin, {
    userIds: [user.id],
    kind: "test",
    vars: { name: profile.full_name.split(" ")[0] ?? profile.full_name },
    url: "/app/settings",
    dedupePrefix,
    ttlSeconds: 120,
    urgency: "high",
    collapseTag: "test",
  });

  const push = enqueued > 0 ? await drainOutbox({ admin, limit: 50, budgetMs: 15_000 }) : null;

  // Find our row among the drained ones; fall back to the DB if another drain took it.
  let delivered = 0;
  let status: string | null = null;
  const { data: row } = await admin
    .from("notifications")
    .select("id, push_status, push_error")
    .eq("dedupe_key", `${dedupePrefix}:${user.id}`)
    .maybeSingle();
  if (row) {
    const mine = push?.rows.find((r) => r.id === row.id);
    delivered = mine?.delivered ?? 0;
    status = mine?.status ?? row.push_status;
  }

  const { count: devicesAfter } = await admin
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("disabled_at", null);

  return ok({
    sent: delivered > 0,
    /** Devices that accepted the push. */
    delivered,
    /** Active subscriptions for this user after pruning gone ones. */
    devices: devicesAfter ?? 0,
    /** Subscriptions that the push service reported gone and were removed. */
    pruned: Math.max(0, (devicesBefore ?? 0) - (devicesAfter ?? 0)),
    status,
    enqueued,
    push: push
      ? {
          claimed: push.claimed,
          sent: push.sent,
          failed: push.failed,
          skipped: push.skipped,
          gone: push.gone,
          requeued: push.requeued,
          deliveries: push.deliveries,
        }
      : null,
  });
});
