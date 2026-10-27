import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { userRoleSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/:id/role — change someone's role (userRoleSchema). You cannot change your own. */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  const { user } = await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, userRoleSchema);
  if (id === user.id) throw new ApiError(403, "FORBIDDEN", "You can't change your own role. Ask another admin.");

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");
  if (target.role === input.role) return ok({ user: target, changed: false });

  const { data, error } = await admin.from("profiles").update({ role: input.role }).eq("id", id).select("*").single();
  if (error || !data) throw fromPostgresError(error);

  // Keep Auth app_metadata in step so a fresh sign-in reads the same role.
  const { error: authError } = await admin.auth.admin.updateUserById(id, { app_metadata: { role: input.role } });
  if (authError) console.error("[admin] could not update auth app_metadata role:", authError.message);

  return ok({ user: data, changed: true });
});
