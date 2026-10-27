import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getTrip } from "@/lib/data/driver";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** POST /api/driver/trips/[id]/claim — "I'm driving this": sets driver_id = me when unassigned (admins may reassign). */
export const POST = withHandler<RouteCtx<{ id: string }>>(async (_request, { params }) => {
  const { id } = await params;
  const { user, profile } = await requireRole("driver");
  const trip = await getTrip(id);
  if (!trip) throw new ApiError(404, "NOT_FOUND", "That trip no longer exists.");
  if (trip.status !== "scheduled" && trip.status !== "boarding" && trip.status !== "departed") {
    throw new ApiError(409, "CONFLICT", "This trip is over.");
  }
  if (trip.driver_id === user.id) return ok({ trip });
  if (trip.driver_id !== null && profile.role !== "admin") {
    throw new ApiError(409, "CONFLICT", "Another driver already took this trip.");
  }

  const admin = createAdminClient();
  let query = admin.from("trips").update({ driver_id: user.id }).eq("id", id);
  if (profile.role !== "admin") query = query.is("driver_id", null);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new ApiError(500, "INTERNAL", "Could not claim the trip. Try again.");
  if (!data) throw new ApiError(409, "CONFLICT", "Another driver already took this trip.");
  return ok({ trip: data });
});
