import { ApiError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { clearLoginFailures, setPin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminResetPinSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/:id/pin — admin resets a user's PIN and clears any lockout. */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, adminResetPinSchema);

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("id, username").eq("id", id).maybeSingle();
  if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");

  await setPin(admin, target.id, target.username, input.pin);
  await clearLoginFailures(admin, target.username);
  return ok({ ok: true });
});
