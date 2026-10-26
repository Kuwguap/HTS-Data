import { fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listDaysOff } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { dayOffSchema } from "@/lib/validation/admin";
import { notifyTripRiders } from "../_shared/notify";

export const dynamic = "force-dynamic";

/** GET /api/admin/days-off — every day off, newest first. */
export const GET = withHandler(async () => {
  await requireRole("admin");
  return ok({ days_off: await listDaysOff() });
});

/**
 * POST /api/admin/days-off — mark a date as no service (dayOffSchema).
 * Trips already created for that date are deleted when nobody booked, otherwise
 * cancelled with reason "No service" and their riders are notified.
 */
export const POST = withHandler(async (request) => {
  const { user } = await requireRole("admin");
  const input = await parseBody(request, dayOffSchema);
  const admin = createAdminClient();
  const settings = await getSettings();

  const { data: dayOff, error } = await admin
    .from("service_days_off")
    .upsert({ service_date: input.service_date, reason: input.reason ?? null }, { onConflict: "service_date" })
    .select("*")
    .single();
  if (error || !dayOff) throw fromPostgresError(error);

  const { data: trips } = await admin
    .from("trips")
    .select("*")
    .eq("service_date", input.service_date)
    .in("status", ["scheduled", "boarding"]);

  let deleted = 0;
  let cancelled = 0;
  let notified = 0;
  const reason = input.reason ? `No service: ${input.reason}` : "No service";
  for (const trip of trips ?? []) {
    const { count } = await admin.from("bookings").select("id", { count: "exact", head: true }).eq("trip_id", trip.id);
    if ((count ?? 0) === 0 && trip.confirmed_count === 0 && trip.waitlist_count === 0) {
      const { error: delError } = await admin.from("trips").delete().eq("id", trip.id);
      if (!delError) {
        deleted++;
        continue;
      }
    }
    const { data: updated, error: cancelError } = await admin.rpc("set_trip_status", {
      p_trip_id: trip.id,
      p_status: "cancelled",
      p_actor: user.id,
      p_reason: reason,
    });
    if (cancelError || !updated) {
      console.error("[admin] day off: could not cancel trip", trip.id, cancelError?.message);
      continue;
    }
    cancelled++;
    notified += await notifyTripRiders(admin, updated, settings, "trip_cancelled", {
      message: reason,
      dedupePrefix: `trip_cancelled:${trip.id}`,
    });
  }

  return ok({ day_off: dayOff, trips_deleted: deleted, trips_cancelled: cancelled, riders_notified: notified });
});
