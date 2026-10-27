import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { requireTripAccess } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import type { BookingStatus, Trip } from "@/lib/db.types";
import { AFTER_DRAIN_BUDGET_MS, enqueueNotification, listActiveStudentIds, notifyAndDrain, scheduleDrain, type EnqueueInput } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime } from "@/lib/time";
import { driverTripStatusSchema } from "@/lib/validation/driver";

export const dynamic = "force-dynamic";

type Admin = ReturnType<typeof createAdminClient>;
type RiderRow = { user_id: string; status: BookingStatus; pickup_location_id: string | null };

/**
 * POST /api/driver/trips/[id]/status { status, reason? }
 * Assigned driver / admin / any driver when unassigned (set_trip_status auto-claims).
 *   boarding  → trip_boarding to confirmed riders ({pickup} = their own pickup point)
 *   departed  → trip_departed to confirmed + boarded riders (opens the live map); for a
 *               trip to the hostel also to every active student with reminders on who
 *               has no booking on it
 *   arrived   → trip_arrived to boarded riders
 *   cancelled → trip_cancelled to confirmed + waitlisted + boarded riders ({message: reason})
 * Nothing is sent when the trip was already in the requested status (dedupe prefixes are
 * per trip + status, so a retry after a crash never notifies twice either).
 */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, { params }) => {
  const { id } = await params;
  const { user, profile } = await requireRole("driver");
  const input = await parseBody(request, driverTripStatusSchema);
  const { trip: before } = await requireTripAccess(id, profile);

  const admin = createAdminClient();
  const { data: trip, error } = await admin.rpc("set_trip_status", {
    p_trip_id: id,
    p_status: input.status,
    p_actor: user.id,
    p_reason: input.reason ?? null,
  });
  if (error) throw fromPostgresError(error);
  if (!trip) throw new ApiError(500, "INTERNAL", "Could not update the trip.");

  // set_trip_status is a no-op when the status is unchanged (double tap / stale page): never re-notify.
  if (before.status !== input.status) {
    const { data } = await admin.from("bookings").select("user_id, status, pickup_location_id").eq("trip_id", id);
    const riders = (data ?? []) as RiderRow[];
    const settings = await getSettings();
    const vars = {
      time: formatTime(trip.departure_at, settings.timezone),
      origin: trip.origin_label,
      destination: trip.destination_label,
      hostel: settings.hostel_name,
      trip_id: trip.id,
    };
    const common = { collapseTag: `trip:${trip.id}`, urgency: "high" as const };
    const ids = (...statuses: BookingStatus[]) => riders.filter((r) => statuses.includes(r.status)).map((r) => r.user_id);

    if (input.status === "boarding") {
      await sendAll(admin, await boardingNotices(admin, trip, riders, vars, common));
    } else if (input.status === "departed") {
      const booked = ids("confirmed", "boarded");
      const notices: EnqueueInput[] = [
        { ...common, userIds: booked, kind: "trip_departed", vars, url: `/app/trips/${trip.id}/map`, dedupePrefix: `departed:${trip.id}`, ttlSeconds: 1800 },
      ];
      if (trip.direction === "to_hostel") {
        // Everyone else with reminders on hears the shuttle is on its way back (they may still catch it at a stop).
        const hasBooking = new Set(riders.map((r) => r.user_id));
        const others = (await listActiveStudentIds(admin, { remindersOnly: true })).filter((uid) => !hasBooking.has(uid));
        notices.push({ ...common, userIds: others, kind: "trip_departed", vars, url: `/app/trips/${trip.id}/map`, dedupePrefix: `departed:${trip.id}:all`, ttlSeconds: 1800 });
      }
      await sendAll(admin, notices);
    } else if (input.status === "arrived") {
      await notifyAndDrain(admin, { ...common, userIds: ids("boarded"), kind: "trip_arrived", vars, url: `/app/trips/${trip.id}`, dedupePrefix: `arrived:${trip.id}`, ttlSeconds: 1800 });
    } else if (input.status === "cancelled") {
      await notifyAndDrain(admin, {
        ...common,
        userIds: ids("confirmed", "waitlisted", "boarded"),
        kind: "trip_cancelled",
        vars: { ...vars, message: input.reason ?? "" },
        url: `/app/trips/${trip.id}`,
        // Same prefix as the admin cancel / day-off routes: one cancellation notice per rider per trip.
        dedupePrefix: `trip_cancelled:${trip.id}:${Date.now()}`,
        ttlSeconds: 3600,
      });
    }
  }

  return ok({ trip });
});

/** trip_boarding, one enqueue per pickup point so {pickup} is the rider's own stop (riders without one get the origin). */
async function boardingNotices(
  admin: Admin,
  trip: Trip,
  riders: RiderRow[],
  vars: Record<string, string>,
  common: Pick<EnqueueInput, "collapseTag" | "urgency">,
): Promise<EnqueueInput[]> {
  const confirmed = riders.filter((r) => r.status === "confirmed");
  if (confirmed.length === 0) return [];
  const byPickup = new Map<string | null, string[]>();
  for (const r of confirmed) byPickup.set(r.pickup_location_id, [...(byPickup.get(r.pickup_location_id) ?? []), r.user_id]);
  const names = new Map<string, string>();
  const pickupIds = [...byPickup.keys()].filter((k): k is string => k !== null);
  if (pickupIds.length > 0) {
    const { data } = await admin.from("pickup_locations").select("id, name").in("id", pickupIds);
    for (const p of data ?? []) names.set(p.id, p.name);
  }
  return [...byPickup.entries()].map(([pickupId, userIds]) => ({
    ...common,
    userIds,
    kind: "trip_boarding",
    vars: { ...vars, pickup: (pickupId && names.get(pickupId)) || trip.origin_label },
    url: `/app/trips/${trip.id}`,
    // One prefix per trip: a rider sits in exactly one pickup group, so the per-user dedupe key is still unique.
    dedupePrefix: `boarding:${trip.id}`,
    ttlSeconds: 900,
  }));
}

/** Enqueue every notice, then one drain after the response. */
async function sendAll(admin: Admin, notices: EnqueueInput[]): Promise<void> {
  let count = 0;
  for (const n of notices) if (n.userIds.length > 0) count += await enqueueNotification(admin, n);
  if (count > 0) await scheduleDrain({ admin, budgetMs: AFTER_DRAIN_BUDGET_MS });
}
