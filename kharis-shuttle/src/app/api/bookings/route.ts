import { ApiError, fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { enqueueNotification, listDriverIds, scheduleDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatFare, formatTime } from "@/lib/time";
import { createBookingSchema } from "@/lib/validation/bookings";

export const dynamic = "force-dynamic";

/**
 * POST /api/bookings — reserve a seat (or a waitlist place) on a trip.
 * Body: createBookingSchema. Response: { booking, trip }.
 * Pushes booking_confirmed / booking_waitlisted to the rider and, once the
 * driver manifest has gone out, driver_booking_update to the driver(s).
 */
export const POST = withHandler(async (request) => {
  const { user, profile } = await requireUser();
  const input = await parseBody(request, createBookingSchema);
  const admin = createAdminClient();

  const { data: booking, error } = await admin.rpc("book_seat", {
    p_user_id: user.id,
    p_trip_id: input.trip_id,
    p_pickup_location_id: input.pickup_location_id ?? null,
    p_pickup_note: input.pickup_note ?? null,
    p_source: "self",
  });
  if (error || !booking) throw fromPostgresError(error ?? new Error("book_seat returned nothing"));

  const { data: trip } = await admin.from("trips").select("*").eq("id", input.trip_id).maybeSingle();
  if (!trip) throw new ApiError(404, "NOT_FOUND", "That departure no longer exists.");

  const settings = await getSettings();
  let pickupName = "your pickup point";
  if (booking.pickup_location_id) {
    const { data: loc } = await admin.from("pickup_locations").select("name").eq("id", booking.pickup_location_id).maybeSingle();
    if (loc?.name) pickupName = loc.name;
  }
  const time = formatTime(trip.departure_at, settings.timezone);
  const fare = formatFare(settings.fare_pesewas, settings.currency);
  const waitlisted = booking.status === "waitlisted";
  // created_at is reset when a cancelled row is re-used, so a re-booking notifies again.
  const stamp = Date.parse(booking.created_at) || 0;

  let enqueued = await enqueueNotification(admin, {
    userIds: [user.id],
    kind: waitlisted ? "booking_waitlisted" : "booking_confirmed",
    vars: {
      time,
      pickup: pickupName,
      fare,
      count: booking.waitlist_position ?? 0,
      destination: trip.destination_label,
      origin: trip.origin_label,
      hostel: settings.hostel_name,
    },
    url: `/app/trips/${trip.id}`,
    dedupePrefix: `booking:${booking.id}:${booking.status}:${stamp}`,
    collapseTag: `booking:${booking.id}`,
  });

  if (trip.manifest_sent_at) {
    const drivers = await listDriverIds(admin, trip.driver_id);
    enqueued += await enqueueNotification(admin, {
      userIds: drivers,
      kind: "driver_booking_update",
      vars: {
        name: profile.full_name,
        pickup: pickupName,
        time,
        message: waitlisted ? "joined the waitlist" : "booked",
        destination: trip.destination_label,
      },
      url: `/driver/trips/${trip.id}`,
      dedupePrefix: `driver_booking_update:${booking.id}:${booking.status}:${stamp}`,
      collapseTag: `manifest:${trip.id}`,
    });
  }
  if (enqueued > 0) await scheduleDrain({ admin });

  return ok({ booking, trip });
});
