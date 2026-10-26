import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { requireTripAccess } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import type { BookingStatus } from "@/lib/db.types";
import { notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime } from "@/lib/time";
import { driverTripStatusSchema } from "@/lib/validation/driver";

export const dynamic = "force-dynamic";

/**
 * POST /api/driver/trips/[id]/status { status, reason? }
 * Assigned driver / admin / any driver when unassigned (set_trip_status auto-claims).
 *   departed  → trip_departed to confirmed riders
 *   cancelled → trip_cancelled to confirmed + waitlisted riders ({message: reason})
 */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, { params }) => {
  const { id } = await params;
  const { user, profile } = await requireRole("driver");
  const input = await parseBody(request, driverTripStatusSchema);
  await requireTripAccess(id, profile);

  const admin = createAdminClient();
  const { data: trip, error } = await admin.rpc("set_trip_status", {
    p_trip_id: id,
    p_status: input.status,
    p_actor: user.id,
    p_reason: input.reason ?? null,
  });
  if (error) throw fromPostgresError(error);
  if (!trip) throw new ApiError(500, "INTERNAL", "Could not update the trip.");

  if (input.status === "departed" || input.status === "cancelled") {
    const statuses: BookingStatus[] = input.status === "departed" ? ["confirmed", "boarded"] : ["confirmed", "waitlisted", "boarded"];
    const { data: riders } = await admin.from("bookings").select("user_id").eq("trip_id", id).in("status", statuses);
    const userIds = (riders ?? []).map((r) => r.user_id);
    if (userIds.length > 0) {
      const settings = await getSettings();
      const vars = {
        time: formatTime(trip.departure_at, settings.timezone),
        origin: trip.origin_label,
        destination: trip.destination_label,
        hostel: settings.hostel_name,
        trip_id: trip.id,
      };
      if (input.status === "departed") {
        await notifyAndDrain(admin, {
          userIds,
          kind: "trip_departed",
          vars,
          url: `/app/trips/${trip.id}/map`,
          dedupePrefix: `departed:${trip.id}`,
          ttlSeconds: 1800,
          urgency: "high",
          collapseTag: `trip:${trip.id}`,
        });
      } else {
        await notifyAndDrain(admin, {
          userIds,
          kind: "trip_cancelled",
          vars: { ...vars, message: input.reason ?? "" },
          url: `/app/trips/${trip.id}`,
          dedupePrefix: `cancelled:${trip.id}`,
          ttlSeconds: 3600,
          urgency: "high",
          collapseTag: `trip:${trip.id}`,
        });
      }
    }
  }

  return ok({ trip });
});
