import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { requireTripAccess } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import type { Booking, CancelBookingResult } from "@/lib/db.types";
import { notifyAndDrain, promotedDedupePrefix } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime } from "@/lib/time";
import { riderStatusSchema } from "@/lib/validation/driver";

export const dynamic = "force-dynamic";

/**
 * POST /api/driver/trips/[id]/bookings/[bookingId] { status: confirmed | boarded | no_show | cancelled }
 * cancelled → cancel_booking(me, id, 'driver') and notify the promoted rider (if any),
 * a no-op when the booking is already cancelled; anything else → set_booking_status.
 * Responds { booking, promoted }.
 */
export const POST = withHandler<RouteCtx<{ id: string; bookingId: string }>>(async (request, { params }) => {
  const { id, bookingId } = await params;
  const { user, profile } = await requireRole("driver");
  const input = await parseBody(request, riderStatusSchema);
  const { trip } = await requireTripAccess(id, profile);

  const admin = createAdminClient();
  const { data: existing } = await admin.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!existing || existing.trip_id !== id) throw new ApiError(404, "NOT_FOUND", "Booking not found on this trip.");

  if (input.status === "cancelled") {
    // Already cancelled (API-only double tap / retry): nothing to free, nobody to promote,
    // and the rider must not get a second booking_cancelled push with a fresh stamp.
    if (existing.status === "cancelled") return ok({ booking: existing, promoted: null });

    const { data, error } = await admin.rpc("cancel_booking", { p_user_id: user.id, p_booking_id: bookingId, p_by: "driver" });
    if (error) throw fromPostgresError(error);
    const result = data as unknown as CancelBookingResult | null;
    const cancelled = result?.cancelled ?? null;
    if (!cancelled) throw new ApiError(500, "INTERNAL", "Could not cancel the booking.");

    const settings = await getSettings();
    const base = {
      time: formatTime(trip.departure_at, settings.timezone),
      destination: trip.destination_label,
      origin: trip.origin_label,
      trip_id: trip.id,
    };
    await notifyAndDrain(admin, {
      userIds: [cancelled.user_id],
      kind: "booking_cancelled",
      vars: { ...base, message: "The driver removed you from this trip." },
      url: `/app/trips/${trip.id}`,
      dedupePrefix: `booking_cancelled:${cancelled.id}:${Date.now()}`,
      collapseTag: `trip:${trip.id}`,
    });
    const promoted = result?.promoted ?? null;
    if (promoted) {
      const pickup = promoted.pickup_location_id
        ? (await admin.from("pickup_locations").select("name").eq("id", promoted.pickup_location_id).maybeSingle()).data?.name
        : null;
      await notifyAndDrain(admin, {
        userIds: [promoted.user_id],
        kind: "booking_promoted",
        vars: { ...base, pickup: pickup ?? "your pickup point" },
        url: `/app/trips/${trip.id}`,
        dedupePrefix: promotedDedupePrefix(promoted),
        urgency: "high",
        collapseTag: `trip:${trip.id}`,
      });
    }
    return ok({ booking: cancelled as Booking, promoted });
  }

  const { data: booking, error } = await admin.rpc("set_booking_status", {
    p_booking_id: bookingId,
    p_status: input.status,
    p_actor: user.id,
  });
  if (error) throw fromPostgresError(error);
  if (!booking) throw new ApiError(500, "INTERNAL", "Could not update the booking.");

  // A no-show frees a seat but SQL deliberately does not auto-promote (the driver may
  // seat whoever is at the gate). Fill it from the waitlist now and tell the riders.
  let promoted: Booking[] = [];
  if (input.status === "no_show") {
    const { data: rows, error: promoteError } = await admin.rpc("promote_waitlist", { p_trip_id: id });
    if (promoteError) throw fromPostgresError(promoteError);
    promoted = (rows ?? []) as Booking[];
    if (promoted.length) {
      const settings = await getSettings();
      const base = {
        time: formatTime(trip.departure_at, settings.timezone),
        destination: trip.destination_label,
        origin: trip.origin_label,
        trip_id: trip.id,
      };
      const locationIds = [...new Set(promoted.map((b) => b.pickup_location_id).filter((v): v is string => !!v))];
      const names = new Map<string, string>();
      if (locationIds.length) {
        const { data: locs } = await admin.from("pickup_locations").select("id, name").in("id", locationIds);
        for (const l of locs ?? []) names.set(l.id, l.name);
      }
      for (const b of promoted) {
        await notifyAndDrain(admin, {
          userIds: [b.user_id],
          kind: "booking_promoted",
          vars: { ...base, pickup: (b.pickup_location_id && names.get(b.pickup_location_id)) || "your pickup point" },
          url: `/app/trips/${trip.id}`,
          dedupePrefix: promotedDedupePrefix(b),
          urgency: "high",
          collapseTag: `trip:${trip.id}`,
        });
      }
    }
  }
  return ok({ booking, promoted });
});
