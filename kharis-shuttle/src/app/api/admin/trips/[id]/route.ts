import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getTripAdmin } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import type { TablesUpdate } from "@/lib/db.types";
import { notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime, localDateString } from "@/lib/time";
import { tripPatchSchema } from "@/lib/validation/admin";
import { notifyTripRiders, tripVars } from "../../_shared/notify";

export const dynamic = "force-dynamic";

/** GET /api/admin/trips/:id — trip + bookings with rider details. */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const data = await getTripAdmin(id);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  return ok(data);
});

/**
 * PATCH /api/admin/trips/:id — edit a trip (tripPatchSchema).
 * - seat_capacity up → promote_waitlist, promoted riders get booking_promoted
 * - departure_at change → reminder times recomputed, active riders get trip_updated
 */
export const PATCH = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, tripPatchSchema);
  if (Object.keys(input).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to change.");

  const admin = createAdminClient();
  const settings = await getSettings();
  const { data: before, error: loadError } = await admin.from("trips").select("*").eq("id", id).maybeSingle();
  if (loadError) throw fromPostgresError(loadError);
  if (!before) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  if (before.status === "cancelled" || before.status === "expired" || before.status === "arrived") {
    throw new ApiError(409, "CONFLICT", "This trip is over and can't be edited.");
  }

  if (input.driver_id) {
    const { data: driver } = await admin.from("profiles").select("id, role, is_active").eq("id", input.driver_id).maybeSingle();
    if (!driver || !driver.is_active || driver.role === "student") {
      throw new ApiError(400, "VALIDATION", "Please check the form.", { fieldErrors: { driver_id: ["Pick an active driver"] } });
    }
  }

  const patch: TablesUpdate<"trips"> = {};
  if (input.seat_capacity !== undefined) patch.seat_capacity = input.seat_capacity;
  if (input.driver_id !== undefined) patch.driver_id = input.driver_id;
  if (input.bookings_enabled !== undefined) patch.bookings_enabled = input.bookings_enabled;
  if (input.origin_label !== undefined) patch.origin_label = input.origin_label;
  if (input.destination_label !== undefined) patch.destination_label = input.destination_label;

  const timeChanged = input.departure_at !== undefined && new Date(input.departure_at).getTime() !== new Date(before.departure_at).getTime();
  if (timeChanged && input.departure_at) {
    const departure = new Date(input.departure_at);
    if (departure.getTime() < Date.now() - 60_000) {
      throw new ApiError(400, "VALIDATION", "Please check the form.", { fieldErrors: { departure_at: ["That time is in the past"] } });
    }
    const reminderAt = new Date(departure.getTime() - settings.reminder_lead_minutes * 60_000);
    patch.departure_at = departure.toISOString();
    patch.service_date = localDateString(departure, settings.timezone);
    patch.reminder_at = reminderAt.toISOString();
    // Let the reminder / nudge / manifest fire again for the new time when it is still ahead.
    if (reminderAt.getTime() > Date.now()) patch.reminder_sent_at = null;
    patch.nudge_sent_at = null;
    patch.manifest_sent_at = null;
  }

  const { data: trip, error } = await admin.from("trips").update(patch).eq("id", id).select("*").single();
  if (error || !trip) throw fromPostgresError(error);

  let promoted = 0;
  if (input.seat_capacity !== undefined && input.seat_capacity > before.seat_capacity && trip.waitlist_count > 0) {
    const { data: rows, error: promoteError } = await admin.rpc("promote_waitlist", { p_trip_id: id });
    if (promoteError) console.error("[admin] promote_waitlist failed:", promoteError.message);
    const bookings = rows ?? [];
    promoted = bookings.length;
    if (bookings.length > 0) {
      const pickupIds = [...new Set(bookings.map((b) => b.pickup_location_id).filter((x): x is string => Boolean(x)))];
      const { data: pickups } = pickupIds.length ? await admin.from("pickup_locations").select("id, name").in("id", pickupIds) : { data: [] };
      const pickupName = new Map((pickups ?? []).map((p) => [p.id, p.name]));
      const vars = tripVars(trip, settings);
      await Promise.all(
        bookings.map((b) =>
          notifyAndDrain(admin, {
            userIds: [b.user_id],
            kind: "booking_promoted",
            vars: { ...vars, pickup: b.pickup_location_id ? (pickupName.get(b.pickup_location_id) ?? "your pickup point") : "your pickup point" },
            url: `/app/trips/${trip.id}`,
            dedupePrefix: `booking_promoted:${b.id}`,
            urgency: "high",
            collapseTag: `trip:${trip.id}`,
          }),
        ),
      );
    }
  }

  let notified = 0;
  if (timeChanged) {
    notified = await notifyTripRiders(admin, trip, settings, "trip_updated", {
      message: `New time: ${formatTime(trip.departure_at, settings.timezone)} (was ${formatTime(before.departure_at, settings.timezone)}).`,
      dedupePrefix: `trip_updated:${trip.id}:${Date.parse(trip.departure_at)}`,
    });
  }

  return ok({ trip, promoted, notified });
});
