import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { requireTripAccess } from "@/lib/data/driver";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * POST /api/pickup-requests/[id]/complete — the driver who accepted the request
 * (or an admin) marks it as picked up; when it is tied to a trip, that trip's
 * driver access is checked too. Idempotent for an already completed request.
 * Responds { request }.
 */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (_request, { params }) => {
  const { id } = await params;
  const { user, profile } = await requireRole("driver");
  const admin = createAdminClient();

  const { data: existing } = await admin.from("pickup_requests").select("id, status, driver_id, trip_id").eq("id", id).maybeSingle();
  if (!existing) throw new ApiError(404, "NOT_FOUND", "That request no longer exists.");
  if (existing.trip_id) await requireTripAccess(existing.trip_id, profile);
  if (profile.role !== "admin" && existing.driver_id !== user.id) {
    throw new ApiError(403, "FORBIDDEN", "Only the driver who accepted this request can mark it as picked up.");
  }
  if (existing.status === "completed") {
    const { data } = await admin.from("pickup_requests").select("*").eq("id", id).maybeSingle();
    return ok({ request: data });
  }
  if (existing.status !== "accepted") throw new ApiError(409, "CONFLICT", "Only an accepted request can be marked as picked up.");

  const { data: updated, error } = await admin
    .from("pickup_requests")
    .update({ status: "completed" })
    .eq("id", id)
    .eq("status", "accepted")
    .select("*")
    .maybeSingle();
  if (error) throw new ApiError(500, "INTERNAL", "Could not update the request. Try again.");
  if (!updated) throw new ApiError(409, "CONFLICT", "The request changed. Refresh and try again.");
  return ok({ request: updated });
});
