import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import type { ScheduleTime, TablesUpdate } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleTimePatchSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

type Admin = ReturnType<typeof createAdminClient>;

/** Outcome of re-syncing the schedule's already materialised future trips. */
export type SchedulePropagation = {
  /** Upcoming trips without a single booking row, deleted so the tick re-creates them (or not). */
  deleted_trips: number;
  /** Upcoming trips that have booking rows: kept with their old values. */
  kept_with_bookings: number;
};

/** Upcoming, still-scheduled trips materialised from this schedule row. */
async function futureTripIds(admin: Admin, scheduleId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("trips")
    .select("id")
    .eq("schedule_time_id", scheduleId)
    .eq("status", "scheduled")
    .gt("departure_at", new Date(Date.now()).toISOString());
  if (error) throw fromPostgresError(error);
  return (data ?? []).map((t) => t.id);
}

/**
 * The tick only materialises a (schedule, date) slot once, so trips already created for
 * today … today + booking_open_days_ahead keep the old time / seats / days after an edit.
 * Delete the bookingless ones (the next tick re-creates them from the new row within a
 * minute, or not at all when the row is paused or gone); trips with ANY booking row —
 * bookings cascade on trip delete and must never be lost — stay as they are and are
 * counted so the admin can change them under Trips.
 */
async function propagateToFutureTrips(admin: Admin, tripIds: string[]): Promise<SchedulePropagation> {
  if (tripIds.length === 0) return { deleted_trips: 0, kept_with_bookings: 0 };
  const { data: booked, error: bookedError } = await admin.from("bookings").select("trip_id").in("trip_id", tripIds);
  if (bookedError) throw fromPostgresError(bookedError);
  const withBookings = new Set((booked ?? []).map((b) => b.trip_id));
  const deletable = tripIds.filter((id) => !withBookings.has(id));
  let deleted = 0;
  if (deletable.length > 0) {
    // The counters double as a guard against a seat booked between the two queries.
    const { data: gone, error } = await admin
      .from("trips")
      .delete()
      .in("id", deletable)
      .eq("status", "scheduled")
      .eq("confirmed_count", 0)
      .eq("waitlist_count", 0)
      .select("id");
    if (error) throw fromPostgresError(error);
    deleted = (gone ?? []).length;
  }
  return { deleted_trips: deleted, kept_with_bookings: withBookings.size };
}

const sameDays = (a: number[], b: number[]) => a.length === b.length && a.every((d, i) => d === b[i]);
/** `time` columns come back as HH:MM:SS; the form sends HH:MM. */
const clock = (t: string) => (t.length >= 5 ? `${t.slice(0, 5)}:${t.length >= 8 ? t.slice(6, 8) : "00"}` : t);

/** Does the patch change anything the materialised trips carry (not the label)? */
function affectsTrips(before: ScheduleTime, patch: TablesUpdate<"schedule_times">): boolean {
  if (patch.direction !== undefined && patch.direction !== before.direction) return true;
  if (patch.depart_time !== undefined && clock(patch.depart_time) !== clock(before.depart_time)) return true;
  if (patch.days_of_week !== undefined && !sameDays(patch.days_of_week, [...before.days_of_week].sort((a, b) => a - b))) return true;
  if (patch.seat_capacity !== undefined && (patch.seat_capacity ?? null) !== (before.seat_capacity ?? null)) return true;
  if (patch.bookings_enabled !== undefined && patch.bookings_enabled !== before.bookings_enabled) return true;
  if (patch.is_active !== undefined && patch.is_active !== before.is_active) return true;
  return false;
}

/**
 * PATCH /api/admin/schedule/:id — edit a departure (scheduleTimePatchSchema). When the
 * time, days, seats, bookings switch, direction or active flag changes, upcoming trips
 * already created from this row are re-synced (see propagateToFutureTrips); a label-only
 * change touches no trip. Responds { schedule_time, deleted_trips, kept_with_bookings }.
 */
export const PATCH = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, scheduleTimePatchSchema);
  // Forward only the keys the body carried: an absent key must never reset its column.
  const patch: TablesUpdate<"schedule_times"> = {};
  if (input.direction !== undefined) patch.direction = input.direction;
  if (input.depart_time !== undefined) patch.depart_time = input.depart_time;
  if (input.days_of_week !== undefined) patch.days_of_week = [...new Set(input.days_of_week)].sort((a, b) => a - b);
  if (input.label !== undefined) patch.label = input.label;
  if (input.seat_capacity !== undefined) patch.seat_capacity = input.seat_capacity;
  if (input.bookings_enabled !== undefined) patch.bookings_enabled = input.bookings_enabled;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (Object.keys(patch).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to change.");

  const admin = createAdminClient();
  const { data: before, error: loadError } = await admin.from("schedule_times").select("*").eq("id", id).maybeSingle();
  if (loadError) throw fromPostgresError(loadError);
  if (!before) throw new ApiError(404, "NOT_FOUND", "Departure not found.");

  const { data, error } = await admin.from("schedule_times").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Departure not found.");

  let propagation: SchedulePropagation = { deleted_trips: 0, kept_with_bookings: 0 };
  if (affectsTrips(before, patch)) {
    propagation = await propagateToFutureTrips(admin, await futureTripIds(admin, id));
  }
  return ok({ schedule_time: data, ...propagation });
});

/**
 * DELETE /api/admin/schedule/:id — remove a departure. Upcoming trips created from it
 * are deleted when they have no booking rows; the rest stay (their schedule_time_id
 * becomes null) and are counted. Responds { deleted, id, deleted_trips, kept_with_bookings }.
 */
export const DELETE = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const admin = createAdminClient();
  // Collect them first: deleting the row sets trips.schedule_time_id to null.
  const tripIds = await futureTripIds(admin, id);
  const { data, error } = await admin.from("schedule_times").delete().eq("id", id).select("id").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Departure not found.");
  const propagation = await propagateToFutureTrips(admin, tripIds);
  return ok({ deleted: true, id, ...propagation });
});
