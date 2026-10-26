import { fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
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
 * return_announcement (to hostel) or trip_reminder (to campus) push.
 */
export const POST = withHandler(async (request) => {
  const { user } = await requireRole("admin");
  const input = await parseBody(request, adhocTripSchema);
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
    notified = await notifyAndDrain(admin, {
      userIds: ids,
      kind: trip.direction === "to_hostel" ? "return_announcement" : "trip_reminder",
      vars: { ...tripVars(trip, settings), count: leavingIn },
      url: `/app/trips/${trip.id}`,
      dedupePrefix: `adhoc:${trip.id}`,
      ttlSeconds: Math.max(300, leavingIn * 60),
      urgency: "high",
      collapseTag: `trip:${trip.id}`,
    });
  }

  return ok({ trip, notified });
});
