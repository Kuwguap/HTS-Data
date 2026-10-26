import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { isNotificationKind } from "@/lib/data/template-defaults";
import { createAdminClient } from "@/lib/supabase/admin";
import { templateSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** PUT /api/admin/templates/:key — set title + body for a notification kind (templateSchema). */
export const PUT = withHandler<RouteCtx<{ key: string }>>(async (request, ctx) => {
  await requireRole("admin");
  const { key } = await ctx.params;
  if (!isNotificationKind(key)) throw new ApiError(404, "NOT_FOUND", "Unknown message kind.");
  const input = await parseBody(request, templateSchema);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("message_templates")
    .upsert({ key, title: input.title, body: input.body, updated_at: new Date().toISOString() }, { onConflict: "key" })
    .select("*")
    .single();
  if (error || !data) throw fromPostgresError(error);
  return ok({ template: data });
});
