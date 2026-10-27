import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { isStaff, requireUser } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { MATCH_MAX_POINTS, matchTrace } from "@/lib/routing/osrm";
import { createAdminClient } from "@/lib/supabase/admin";
import { withinStudentWindow } from "@/lib/trips/visibility";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/**
 * GET /api/trips/[id]/matched — the bus's last 100 GPS fixes snapped to the road
 * network (OSRM match, in cached chunks of ≤ 10 coordinates for the public router). Read-only; any signed-in user who can see the trip.
 * `geometry` is null (200, never 5xx) when there are fewer than two fixes or the
 * router is unavailable; the map then draws the raw fixes. `from_recorded_at` /
 * `through_recorded_at` bound the fixes the geometry covers so the client can keep
 * older and newer raw fixes around it. Answers may be cached 15 s per viewer.
 */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  const { profile } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Trip not found.");

  const admin = createAdminClient();
  const { data: trip } = await admin.from("trips").select("id, service_date").eq("id", id).maybeSingle();
  if (!trip) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  if (!isStaff(profile)) {
    const settings = await getSettings();
    if (!withinStudentWindow(trip.service_date, settings.timezone)) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  }

  const { data } = await admin
    .from("trip_locations")
    .select("id, lat, lng, accuracy_m, recorded_at")
    .eq("trip_id", id)
    .order("id", { ascending: false })
    .limit(MATCH_MAX_POINTS);
  const fixes = [...(data ?? [])].reverse(); // oldest → newest
  const newest = fixes[fixes.length - 1] ?? null;
  const headers = { "Cache-Control": "private, max-age=15" };

  const matched =
    fixes.length >= 2
      ? await matchTrace(
          fixes.map((f) => ({ lat: f.lat, lng: f.lng, at: Date.parse(f.recorded_at), accuracyM: f.accuracy_m })),
          `${id}:${newest?.id ?? 0}`,
          id,
        )
      : null;

  // The matcher snaps the trace in chunks and may cover only part of the window
  // (older chunks fill in on later calls); report the exact fixes it covers, in the
  // database's own timestamp format so the client can splice raw fixes around it.
  const recordedAt = new Map(fixes.map((f) => [Date.parse(f.recorded_at), f.recorded_at] as const));
  const bound = (at: number | undefined, fallback: string | null) =>
    at == null ? fallback : (recordedAt.get(at) ?? new Date(at).toISOString());

  return ok(
    {
      geometry: matched?.geometry ?? null,
      confidence: matched?.confidence ?? 0,
      through_point_id: newest?.id ?? null,
      points_used: fixes.length,
      from_recorded_at: bound(matched?.fromAt, fixes[0]?.recorded_at ?? null),
      through_recorded_at: bound(matched?.throughAt, newest?.recorded_at ?? null),
    },
    { headers },
  );
});
