import { ApiError, fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listTrips } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { listActiveStudentIds, notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDateString, minutesBetween } from "@/lib/time";
import { adhocTripSchema } from "@/lib/validation/admin";
import { isoDate } from "@/lib/validation/common";
import { tripVars } from "../_shared/notify";

export const dynamic = "force-dynamic";

/** GET /api/admin/trips?from=YYYY-MM-DD&to=YYYY-MM-DD — trips by service date (default: today). */
export const GET = withHandler(async (request) => {
  await requireRole("admin");
  const settings = await getSettings();
  const url = new URL(request.url);
  const today = localDateString(new Date(), settings.timezone);
  const from = isoDate.safeParse(url.searchParams.get("from") ?? today);
  const to = isoDate.safeParse(url.searchParams.get("to") ?? from.data ?? today);
  const trips = await listTrips({ from: from.success ? from.data : today, to: to.success ? to.data : today });
  return ok({ trips });
});

/**
 * POST /api/admin/trips — create an extra (ad-hoc) trip (adhocTripSchema) via
 * create_adhoc_trip. With `notify: true`, students with reminders on get a
 * return_announcement (to hostel) or trip_reminder (to campus) push. A to-campus
 * reminder sent this early uses the tick's own dedupe prefix
 * ('reminder:<trip_id>:<departure epoch seconds>', see run_tick) so the tick does
 * not send a second one when reminder_at comes round.
 */
function reminderDedupePrefix(trip: { id: string; departure_at: string }): string {
  return `reminder:${trip.id}:${Math.round(Date.parse(trip.departure_at) / 1000)}`;
}

function fieldError(field: string, message: string): ApiError {
  return new ApiError(400, "VALIDATION", "Please check the form.", { fieldErrors: { [field]: [message] } });
}

/** Same tolerance as the PATCH route: a departure more than a minute ago is a mistake. */
const PAST_TOLERANCE_MS = 60_000;

export const POST = withHandler(async (request) => {
  const { user } = await requireRole("admin");
  const input = await parseBody(request, adhocTripSchema);
  // create_adhoc_trip would happily create a trip that is already "boarding" (or past
  // its cutoff) and show it on every student's Today list.
  if (new Date(input.departure_at).getTime() < Date.now() - PAST_TOLERANCE_MS) {
    throw fieldError("departure_at", "That time is in the past");
  }
  const admin = createAdminClient();
  const settings = await getSettings();

  const { data: trip, error } = await admin.rpc("create_adhoc_trip", {
    p_direction: input.direction,
    p_origin: input.origin_label,
    p_destination: input.destination_label,
    p_departure_at: input.departure_at,
    p_seat_capacity: input.seat_capacity ?? null,
    p_driver_id: input.driver_id ?? null,
    p_created_by: user.id,
  });
  if (error || !trip) throw fromPostgresError(error);

  let notified = 0;
  if (input.notify) {
    const ids = await listActiveStudentIds(admin, { remindersOnly: true });
    const leavingIn = Math.max(0, minutesBetween(new Date(), trip.departure_at));
    const isReminder = trip.direction !== "to_hostel";
    // create_adhoc_trip only schedules a tick reminder (reminder_at) when the lead has not passed yet.
    const tickWillRemind = isReminder && trip.reminder_at != null && leavingIn > settings.reminder_lead_minutes;
    notified = await notifyAndDrain(admin, {
      userIds: ids,
      kind: isReminder ? "trip_reminder" : "return_announcement",
      vars: { ...tripVars(trip, settings), count: leavingIn },
      url: `/app/trips/${trip.id}`,
      dedupePrefix: tickWillRemind ? reminderDedupePrefix(trip) : `adhoc:${trip.id}`,
      ttlSeconds: Math.max(300, leavingIn * 60),
      urgency: "high",
      collapseTag: `trip:${trip.id}`,
    });
  }

  return ok({ trip, notified });
});
