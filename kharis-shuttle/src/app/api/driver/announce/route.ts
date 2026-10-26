import { ApiError, fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { listActiveStudentIds, notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatFare } from "@/lib/time";
import { announceTripSchema } from "@/lib/validation/driver";

export const dynamic = "force-dynamic";

/**
 * POST /api/driver/announce { direction?, origin_label, destination_label?, leaving_in_minutes?, seat_capacity?, message? }
 * Creates an ad-hoc trip (boarding when leaving within 15 min), assigns it to the
 * caller and pushes return_announcement to every active student with reminders on.
 * Responds { trip }.
 */
export const POST = withHandler(async (request) => {
  const { user } = await requireRole("driver");
  const input = await parseBody(request, announceTripSchema);
  const settings = await getSettings();
  const admin = createAdminClient();

  const destination = input.destination_label?.trim() || (input.direction === "to_hostel" ? settings.hostel_name : settings.campus_name);
  const departureAt = new Date(Date.now() + input.leaving_in_minutes * 60_000).toISOString();

  const { data: created, error } = await admin.rpc("create_adhoc_trip", {
    p_direction: input.direction,
    p_origin: input.origin_label,
    p_destination: destination,
    p_departure_at: departureAt,
    p_seat_capacity: input.seat_capacity ?? settings.default_seat_capacity,
    p_driver_id: user.id,
    p_created_by: user.id,
  });
  if (error) throw fromPostgresError(error);
  if (!created) throw new ApiError(500, "INTERNAL", "Could not create the trip.");

  let trip = created;
  if (trip.status === "scheduled" && input.leaving_in_minutes <= 15) {
    const { data: boarding, error: statusError } = await admin.rpc("set_trip_status", {
      p_trip_id: trip.id,
      p_status: "boarding",
      p_actor: user.id,
      p_reason: null,
    });
    if (!statusError && boarding) trip = boarding;
  }

  // The return-trip shout-out goes to every active student (it replaces the group message),
  // not only those who opted into scheduled reminders.
  const studentIds = await listActiveStudentIds(admin, { remindersOnly: false });
  await notifyAndDrain(admin, {
    userIds: studentIds,
    kind: "return_announcement",
    vars: {
      origin: trip.origin_label,
      hostel: settings.hostel_name,
      campus: settings.campus_name,
      destination: trip.destination_label,
      count: input.leaving_in_minutes,
      fare: formatFare(settings.fare_pesewas, settings.currency),
      message: input.message ?? "",
      seats: trip.seat_capacity,
      trip_id: trip.id,
    },
    url: `/app/trips/${trip.id}/map`,
    dedupePrefix: `announce:${trip.id}`,
    ttlSeconds: Math.max(600, (input.leaving_in_minutes + 15) * 60),
    urgency: "high",
    collapseTag: `trip:${trip.id}`,
  });

  return ok({ trip });
});
