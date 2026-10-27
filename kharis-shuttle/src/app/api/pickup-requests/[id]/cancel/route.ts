import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/**
 * POST /api/pickup-requests/[id]/cancel — the rider withdraws a pending/accepted request.
 * When the driver had already ACCEPTED it, that driver gets pickup_request_cancelled so
 * they stop waiting at the pickup point. Response: { request }.
 */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  const { user, profile } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Request not found.");

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("pickup_requests")
    .select("id, rider_id, status, driver_id, pickup_location_id, custom_place, lat, lng")
    .eq("id", id)
    .maybeSingle();
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

  if (existing.status === "accepted" && existing.driver_id) {
    // Same place wording as the create route (pickup_request_new).
    let pickupName: string | null = null;
    if (existing.pickup_location_id) {
      const { data: loc } = await admin.from("pickup_locations").select("name").eq("id", existing.pickup_location_id).maybeSingle();
      pickupName = loc?.name ?? null;
    }
    const place =
      pickupName ??
      existing.custom_place ??
      (existing.lat != null && existing.lng != null ? `${existing.lat.toFixed(5)}, ${existing.lng.toFixed(5)}` : "a custom spot");
    await notifyAndDrain(admin, {
      userIds: [existing.driver_id],
      kind: "pickup_request_cancelled",
      vars: { name: profile.full_name, pickup: place, request_id: existing.id },
      url: "/driver/requests",
      dedupePrefix: `pickup_request_cancelled:${existing.id}`,
      ttlSeconds: 900,
      urgency: "high",
      collapseTag: `pr:${existing.id}`,
    });
  }

  return ok({ request: data });
});
