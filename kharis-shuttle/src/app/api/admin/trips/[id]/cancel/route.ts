import { fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { tripCancelSchema } from "@/lib/validation/admin";
import { notifyTripRiders } from "../../../_shared/notify";

export const dynamic = "force-dynamic";

/** POST /api/admin/trips/:id/cancel — cancel a trip with a reason (tripCancelSchema); confirmed + waitlisted riders get trip_cancelled. */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  const { user } = await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, tripCancelSchema);
  const admin = createAdminClient();
  const settings = await getSettings();

  const { data: trip, error } = await admin.rpc("set_trip_status", {
    p_trip_id: id,
    p_status: "cancelled",
    p_actor: user.id,
    p_reason: input.reason,
  });
  if (error || !trip) throw fromPostgresError(error);

  const notified = await notifyTripRiders(admin, trip, settings, "trip_cancelled", {
    message: input.reason,
    dedupePrefix: `trip_cancelled:${trip.id}`,
    statuses: ["confirmed", "waitlisted", "boarded"],
  });
  return ok({ trip, notified });
});
