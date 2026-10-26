import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { isStaff, requireUser } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/** GET /api/pickup-requests/[id] — one request (its owner or any staff member). */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  const { user, profile } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Request not found.");

  const admin = createAdminClient();
  const { data } = await admin.from("pickup_requests").select("*").eq("id", id).maybeSingle();
  if (!data || (data.rider_id !== user.id && !isStaff(profile))) {
    throw new ApiError(404, "NOT_FOUND", "Request not found.");
  }

  let pickup_name: string | null = null;
  if (data.pickup_location_id) {
    const { data: loc } = await admin.from("pickup_locations").select("name").eq("id", data.pickup_location_id).maybeSingle();
    pickup_name = loc?.name ?? null;
  }
  return ok({ request: data, pickup_name }, { headers: { "Cache-Control": "no-store" } });
});
