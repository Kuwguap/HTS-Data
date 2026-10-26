import { ApiError, fromPostgresError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { isStaff, requireUser } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import type { CancelBookingResult } from "@/lib/db.types";
import { enqueueNotification, listDriverIds, scheduleDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime } from "@/lib/time";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/**
 * POST /api/bookings/[id]/cancel — cancel my booking. Frees the seat and
 * promotes the next waitlisted rider (pushed booking_promoted); tells the
 * driver when the manifest already went out. Response: { cancelled, promoted }.
 */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  const { user, profile } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Booking not found.");
  const admin = createAdminClient();

  const { data: existing } = await admin.from("bookings").select("id, user_id, trip_id").eq("id", id).maybeSingle();
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Booking not found.");
  if (existing.user_id !== user.id && !isStaff(profile)) {
    throw new ApiError(403, "FORBIDDEN", "You can only cancel your own booking.");
  }

  const { data, error } = await admin.rpc("cancel_booking", { p_user_id: user.id, p_booking_id: id, p_by: "self" });
  if (error || !data) throw fromPostgresError(error ?? new Error("cancel_booking returned nothing"));
  const result = data as unknown as CancelBookingResult;

  const { data: trip } = await admin.from("trips").select("*").eq("id", existing.trip_id).maybeSingle();
  if (trip) {
    const settings = await getSettings();
    const time = formatTime(trip.departure_at, settings.timezone);
    let enqueued = 0;

    if (result.promoted) {
      const promoted = result.promoted;
      let pickupName = "your pickup point";
      if (promoted.pickup_location_id) {
        const { data: loc } = await admin.from("pickup_locations").select("name").eq("id", promoted.pickup_location_id).maybeSingle();
        if (loc?.name) pickupName = loc.name;
      }
      enqueued += await enqueueNotification(admin, {
        userIds: [promoted.user_id],
        kind: "booking_promoted",
        vars: { time, destination: trip.destination_label, origin: trip.origin_label, pickup: pickupName },
        url: `/app/trips/${trip.id}`,
        dedupePrefix: `booking:${promoted.id}:promoted:${Date.parse(promoted.promoted_at ?? "") || Date.now()}`,
        urgency: "high",
        collapseTag: `booking:${promoted.id}`,
      });
    }

    if (trip.manifest_sent_at && result.cancelled && result.cancelled.user_id === user.id) {
      let pickupName = "no pickup point";
      if (result.cancelled.pickup_location_id) {
        const { data: loc } = await admin
          .from("pickup_locations")
          .select("name")
          .eq("id", result.cancelled.pickup_location_id)
          .maybeSingle();
        if (loc?.name) pickupName = loc.name;
      }
      const drivers = await listDriverIds(admin, trip.driver_id);
      enqueued += await enqueueNotification(admin, {
        userIds: drivers,
        kind: "driver_booking_update",
        vars: { name: profile.full_name, pickup: pickupName, time, message: "cancelled", destination: trip.destination_label },
        url: `/driver/trips/${trip.id}`,
        dedupePrefix: `driver_booking_update:${result.cancelled.id}:cancelled:${Date.parse(result.cancelled.cancelled_at ?? "") || Date.now()}`,
        collapseTag: `manifest:${trip.id}`,
      });
    }
    if (enqueued > 0) await scheduleDrain({ admin });
  }

  return ok({ cancelled: result.cancelled, promoted: Boolean(result.promoted) });
});
