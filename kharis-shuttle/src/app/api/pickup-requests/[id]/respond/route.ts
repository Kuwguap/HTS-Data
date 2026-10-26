import { ApiError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { requestPlace, requireTripAccess } from "@/lib/data/driver";
import type { PickupLocation } from "@/lib/db.types";
import { notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { respondPickupRequestSchema } from "@/lib/validation/bookings";

export const dynamic = "force-dynamic";

/**
 * POST /api/pickup-requests/[id]/respond { action: accept | decline, note? }
 * Driver only, only while pending. When the request is tied to a trip, only that
 * trip's driver (or an admin, or any driver while nobody is assigned) may answer.
 * Sets status, driver_id, responded_at, response_note and notifies the rider.
 * Responds { request }.
 */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, { params }) => {
  const { id } = await params;
  const { user, profile } = await requireRole("driver");
  const input = await parseBody(request, respondPickupRequestSchema);
  const admin = createAdminClient();

  const { data: existing } = await admin.from("pickup_requests").select("*").eq("id", id).maybeSingle();
  if (!existing) throw new ApiError(404, "NOT_FOUND", "That request no longer exists.");
  if (existing.trip_id) await requireTripAccess(existing.trip_id, profile);
  if (existing.status !== "pending") throw new ApiError(409, "CONFLICT", "This request was already answered.");
  if (new Date(existing.expires_at).getTime() < Date.now()) throw new ApiError(409, "CONFLICT", "This request has expired.");

  const status = input.action === "accept" ? "accepted" : "declined";
  const { data: updated, error } = await admin
    .from("pickup_requests")
    .update({ status, driver_id: user.id, responded_at: new Date().toISOString(), response_note: input.note ?? null })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw new ApiError(500, "INTERNAL", "Could not save your answer. Try again.");
  if (!updated) throw new ApiError(409, "CONFLICT", "This request was already answered.");

  const locations = new Map<string, PickupLocation>();
  if (updated.pickup_location_id) {
    const { data: loc } = await admin.from("pickup_locations").select("*").eq("id", updated.pickup_location_id).maybeSingle();
    if (loc) locations.set(loc.id, loc);
  }
  const { data: driver } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();

  await notifyAndDrain(admin, {
    userIds: [updated.rider_id],
    kind: status === "accepted" ? "pickup_request_accepted" : "pickup_request_declined",
    vars: {
      pickup: requestPlace(updated, locations),
      message: input.note ?? (status === "declined" ? "The driver can’t make this pickup." : ""),
      name: driver?.full_name ?? "The driver",
      request_id: updated.id,
    },
    url: `/app/requests/${updated.id}`,
    dedupePrefix: `pr_${status}:${updated.id}`,
    ttlSeconds: 1800,
    urgency: "high",
    collapseTag: `request:${updated.id}`,
  });

  return ok({ request: updated });
});
