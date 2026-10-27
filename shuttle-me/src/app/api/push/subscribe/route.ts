import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@/lib/validation/push";

/**
 * POST /api/push/subscribe — save (or refresh) the caller's push subscription.
 * Idempotent: upserts on `endpoint`, re-attaching it to the current user and
 * clearing any failure/disabled state so rotated endpoints come back to life.
 */
export const POST = withHandler(async (request) => {
  const { user } = await requireUser();
  const body = await parseBody(request, pushSubscribeSchema);
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      user_agent: body.user_agent ?? request.headers.get("user-agent")?.slice(0, 512) ?? null,
      platform: body.platform ?? null,
      last_seen_at: now,
      disabled_at: null,
      fail_count: 0,
    },
    { onConflict: "endpoint" },
  );
  if (error) {
    console.error("[push] subscribe upsert failed:", error.message);
    throw new ApiError(500, "INTERNAL", "Could not save the subscription.");
  }

  return ok({ ok: true, endpoint: body.endpoint });
});

/** DELETE /api/push/subscribe { endpoint } — remove one of the caller's own subscriptions. */
export const DELETE = withHandler(async (request) => {
  const { user } = await requireUser();
  const body = await parseBody(request, pushUnsubscribeSchema);
  const admin = createAdminClient();

  const { error } = await admin.from("push_subscriptions").delete().eq("endpoint", body.endpoint).eq("user_id", user.id);
  if (error) {
    console.error("[push] unsubscribe delete failed:", error.message);
    throw new ApiError(500, "INTERNAL", "Could not remove the subscription.");
  }

  return ok({ ok: true });
});
