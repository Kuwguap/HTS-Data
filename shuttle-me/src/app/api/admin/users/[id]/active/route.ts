import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { userActiveSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/:id/active — activate / deactivate an account (userActiveSchema). You cannot deactivate yourself. */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  const { user } = await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, userActiveSchema);
  if (id === user.id && !input.is_active) throw new ApiError(403, "FORBIDDEN", "You can't deactivate your own account.");

  const admin = createAdminClient();
  const { data, error } = await admin.from("profiles").update({ is_active: input.is_active }).eq("id", id).select("*").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "User not found.");

  if (!input.is_active) {
    // Stop pushes to a deactivated account; subscriptions are re-enabled on the next subscribe.
    await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("user_id", id).is("disabled_at", null);
  }
  return ok({ user: data });
});
