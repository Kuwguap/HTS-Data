import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { isStaff, requireUser } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, localDateString } from "@/lib/time";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

const MAX_POINTS = 500;

/**
 * Same window as the trips RLS policy (0006_rls.sql): students see trips from
 * local yesterday onwards; staff see everything. Older trips read as missing.
 */
function withinStudentWindow(serviceDate: string, timeZone: string, now = new Date()): boolean {
  return serviceDate >= localDateString(addDays(now, -1), timeZone);
}

/**
 * GET /api/trips/[id]/location?since=<lastPointId> — polling fallback for the
 * live map (any signed-in user). Returns the trip's last known position and the
 * GPS points with id > since, ascending, at most 500.
 */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  const { profile } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Trip not found.");

  const sinceRaw = Number(new URL(request.url).searchParams.get("since") ?? "0");
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("trips")
    .select("id, status, service_date, last_lat, last_lng, last_heading, last_speed_mps, last_location_at")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  if (!isStaff(profile)) {
    const settings = await getSettings();
    if (!withinStudentWindow(row.service_date, settings.timezone)) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  }
  const { service_date: _serviceDate, ...trip } = row;

  const { data: points } = await admin
    .from("trip_locations")
    .select("id, lat, lng, heading, speed_mps, accuracy_m, recorded_at")
    .eq("trip_id", id)
    .gt("id", since)
    .order("id", { ascending: true })
    .limit(MAX_POINTS);

  return ok(
    { trip, points: points ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
});
