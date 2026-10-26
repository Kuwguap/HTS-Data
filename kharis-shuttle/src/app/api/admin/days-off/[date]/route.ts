import { ApiError, fromPostgresError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import type { TablesUpdate } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { isoDate } from "@/lib/validation/common";
import { notifyTripRiders } from "../../_shared/notify";

export const dynamic = "force-dynamic";

/** Prefix set_trip_status stores when POST /api/admin/days-off cancels a trip ("No service" / "No service: <reason>"). */
const NO_SERVICE_PREFIX = "No service";

/**
 * DELETE /api/admin/days-off/:date — service resumes.
 * Trips the day-off cancelled ("No service…") still occupy their (schedule_time_id, service_date)
 * slot, so the tick cannot recreate them: those still ahead are re-opened in place (status
 * back to scheduled, cancel + sent flags cleared so reminders fire for the restored time) and
 * their riders get a trip_updated "back on" push; those already past are deleted. Trips the
 * day-off deleted outright are recreated by the next tick when the date is in the booking window.
 */
export const DELETE = withHandler<RouteCtx<{ date: string }>>(async (_request, ctx) => {
  await requireRole("admin");
  const { date } = await ctx.params;
  const parsed = isoDate.safeParse(date);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "Use a YYYY-MM-DD date.");

  const admin = createAdminClient();
  const { data, error } = await admin.from("service_days_off").delete().eq("service_date", parsed.data).select("service_date").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "That day was not marked off.");

  const { data: cancelledTrips, error: tripsError } = await admin
    .from("trips")
    .select("*")
    .eq("service_date", parsed.data)
    .eq("status", "cancelled")
    .ilike("cancel_reason", `${NO_SERVICE_PREFIX}%`);
  if (tripsError) console.error("[admin] resume day: could not list cancelled trips", tripsError.message);

  const trips = cancelledTrips ?? [];
  const now = Date.now();
  const ahead = trips.filter((t) => Date.parse(t.departure_at) > now);
  const past = trips.filter((t) => Date.parse(t.departure_at) <= now);

  // bookings_enabled was switched off by the cancel: restore it from the schedule row (ad-hoc trips: on).
  const scheduleIds = [...new Set(ahead.map((t) => t.schedule_time_id).filter((id): id is string => Boolean(id)))];
  const { data: scheduleRows } = scheduleIds.length
    ? await admin.from("schedule_times").select("id, bookings_enabled").in("id", scheduleIds)
    : { data: [] as Array<{ id: string; bookings_enabled: boolean }> };
  const bookingsEnabled = new Map((scheduleRows ?? []).map((s) => [s.id, s.bookings_enabled]));

  const settings = await getSettings();
  let restored = 0;
  let deleted = 0;
  let notified = 0;

  for (const trip of ahead) {
    const patch: TablesUpdate<"trips"> = {
      status: "scheduled",
      cancelled_at: null,
      cancel_reason: null,
      bookings_enabled: trip.schedule_time_id ? (bookingsEnabled.get(trip.schedule_time_id) ?? true) : true,
      reminder_sent_at: null,
      nudge_sent_at: null,
      manifest_sent_at: null,
    };
    const { data: updated, error: updateError } = await admin
      .from("trips")
      .update(patch)
      .eq("id", trip.id)
      .eq("status", "cancelled")
      .select("*")
      .maybeSingle();
    if (updateError || !updated) {
      console.error("[admin] resume day: could not re-open trip", trip.id, updateError?.message);
      continue;
    }
    restored++;
    notified += await notifyTripRiders(admin, updated, settings, "trip_updated", {
      message: "Service is back on — this shuttle runs as planned.",
      dedupePrefix: `trip_restored:${trip.id}:${Date.parse(trip.cancelled_at ?? "") || now}`,
    });
  }

  if (past.length > 0) {
    const { error: deleteError, count } = await admin
      .from("trips")
      .delete({ count: "exact" })
      .in(
        "id",
        past.map((t) => t.id),
      )
      .eq("status", "cancelled");
    if (deleteError) console.error("[admin] resume day: could not delete past trips", deleteError.message);
    else deleted = count ?? 0;
  }

  return ok({ deleted: true, service_date: parsed.data, trips_restored: restored, trips_deleted: deleted, riders_notified: notified });
});
