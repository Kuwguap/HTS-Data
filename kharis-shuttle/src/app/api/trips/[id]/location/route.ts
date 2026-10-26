import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

const MAX_POINTS = 500;

/**
 * GET /api/trips/[id]/location?since=<lastPointId> — polling fallback for the
 * live map (any signed-in user). Returns the trip's last known position and the
 * GPS points with id > since, ascending, at most 500.
 */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Trip not found.");

  const sinceRaw = Number(new URL(request.url).searchParams.get("since") ?? "0");
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;

  const admin = createAdminClient();
  const { data: trip } = await admin
    .from("trips")
    .select("id, status, last_lat, last_lng, last_heading, last_speed_mps, last_location_at")
    .eq("id", id)
    .maybeSingle();
  if (!trip) throw new ApiError(404, "NOT_FOUND", "Trip not found.");

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
