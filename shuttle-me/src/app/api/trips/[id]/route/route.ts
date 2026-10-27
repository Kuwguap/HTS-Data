import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { isStaff, requireUser } from "@/lib/auth/require";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import type { LatLng } from "@/lib/geo";
import { routeVia } from "@/lib/routing/osrm";
import { createAdminClient } from "@/lib/supabase/admin";
import { tripDestination } from "@/lib/trips/endpoints";
import { withinStudentWindow } from "@/lib/trips/visibility";
import { lat as latSchema, lng as lngSchema, uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/** `via=lat,lng` → LatLng; absent → null; malformed → 400. */
function parseVia(raw: string | null): LatLng | null {
  if (raw == null || raw === "") return null;
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(raw.trim());
  const lat = m ? Number(m[1]) : Number.NaN;
  const lng = m ? Number(m[2]) : Number.NaN;
  if (!m || !latSchema.safeParse(lat).success || !lngSchema.safeParse(lng).success) {
    throw new ApiError(400, "VALIDATION", "Please check the form.", { fieldErrors: { via: ["Use via=lat,lng"] } });
  }
  return { lat, lng };
}

/**
 * GET /api/trips/[id]/route?via=lat,lng — the road route from the bus's last known
 * position, through the optional via point (the viewer's pickup), to the trip's
 * destination (settings coordinates or the first pickup point on the far side).
 * Read-only; any signed-in user who can see the trip. `route` is null with a
 * `reason` when there is no position, no destination, or the router is unavailable —
 * never a 5xx for that. Answers may be cached 20 s per viewer.
 */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  const { profile } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  const via = parseVia(new URL(request.url).searchParams.get("via"));

  const admin = createAdminClient();
  const { data: trip } = await admin.from("trips").select("id, direction, status, service_date, last_lat, last_lng").eq("id", id).maybeSingle();
  if (!trip) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  const settings = await getSettings();
  if (!isStaff(profile) && !withinStudentWindow(trip.service_date, settings.timezone)) throw new ApiError(404, "NOT_FOUND", "Trip not found.");

  const headers = { "Cache-Control": "private, max-age=20" };
  if (trip.last_lat == null || trip.last_lng == null) return ok({ route: null, reason: "no_position" }, { headers });
  const from: LatLng = { lat: trip.last_lat, lng: trip.last_lng };

  const destination = tripDestination(trip, settings, await getActivePickupLocations());
  if (!destination) return ok({ route: null, reason: "no_destination" }, { headers });

  const points = via ? [from, via, destination] : [from, destination];
  const result = await routeVia(points);
  const route = result
    ? {
        geometry: result.geometry,
        distance_m: result.distanceM,
        duration_s: result.durationS,
        legs: result.legs.map((l) => ({ distance_m: l.distanceM, duration_s: l.durationS })),
      }
    : null;
  return ok(
    { route, reason: route ? undefined : "router_unavailable", destination, from, computed_at: new Date().toISOString() },
    { headers },
  );
});
