import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/** POST /api/pickup-requests/[id]/cancel — the rider withdraws a pending/accepted request. */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  const { user } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Request not found.");

  const admin = createAdminClient();
  const { data: existing } = await admin.from("pickup_requests").select("id, rider_id, status").eq("id", id).maybeSingle();
  if (!existing || existing.rider_id !== user.id) throw new ApiError(404, "NOT_FOUND", "Request not found.");
  if (existing.status === "cancelled") {
    const { data } = await admin.from("pickup_requests").select("*").eq("id", id).single();
    return ok({ request: data });
  }
  if (existing.status !== "pending" && existing.status !== "accepted") {
    throw new ApiError(409, "CONFLICT", "This request can no longer be cancelled.");
  }

  const { data, error } = await admin
    .from("pickup_requests")
    .update({ status: "cancelled", responded_at: existing.status === "pending" ? new Date().toISOString() : undefined })
    .eq("id", id)
    .eq("rider_id", user.id)
    .in("status", ["pending", "accepted"])
    .select("*")
    .maybeSingle();
  if (error) throw new ApiError(500, "INTERNAL", "Could not cancel the request. Try again.");
  if (!data) throw new ApiError(409, "CONFLICT", "This request can no longer be cancelled.");
  return ok({ request: data });
});
