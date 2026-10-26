import { ApiError, fromPostgresError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { isoDate } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/** DELETE /api/admin/days-off/:date — service resumes; the next tick recreates that day's trips if it is still in the booking window. */
export const DELETE = withHandler<RouteCtx<{ date: string }>>(async (_request, ctx) => {
  await requireRole("admin");
  const { date } = await ctx.params;
  const parsed = isoDate.safeParse(date);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "Use a YYYY-MM-DD date.");

  const admin = createAdminClient();
  const { data, error } = await admin.from("service_days_off").delete().eq("service_date", parsed.data).select("service_date").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "That day was not marked off.");
  return ok({ deleted: true, service_date: parsed.data });
});
