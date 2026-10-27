import { after } from "next/server";
import { ApiError, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { requireTripAccess } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import type { TablesInsert, Trip } from "@/lib/db.types";
import { notifyApproaching } from "@/lib/notify/approaching";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime } from "@/lib/time";
import { locationBatchSchema } from "@/lib/validation/driver";

export const dynamic = "force-dynamic";

const MAX_POINTS = 50;

/**
 * POST /api/driver/location { trip_id, points: [{lat, lng, accuracy?, heading?, speed?, at}] }
 * Body may be JSON or text/plain (navigator.sendBeacon). Trip must be boarding or
 * departed and ours (or unassigned → claimed, or caller is admin). Inserts
 * trip_locations rows; the DB trigger updates trips.last_* and broadcasts. 204.
 * After the response, riders whose pickup is within 400 m of the newest point get
 * trip_approaching (once per booking; see src/lib/notify/approaching.ts).
 */
export const POST = withHandler(async (request) => {
  const { user, profile } = await requireRole("driver");

  let json: unknown;
  try {
    const text = await request.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(400, "VALIDATION", "Body must be JSON");
  }
  if (json && typeof json === "object" && Array.isArray((json as { points?: unknown[] }).points) && (json as { points: unknown[] }).points.length > MAX_POINTS) {
    throw new ApiError(400, "VALIDATION", `Send at most ${MAX_POINTS} points per request.`);
  }
  const parsed = locationBatchSchema.safeParse(json);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "Please check the form.", parsed.error.flatten());
  const input = parsed.data;

  const { trip, claimable } = await requireTripAccess(input.trip_id, profile);
  if (trip.status !== "boarding" && trip.status !== "departed") {
    throw new ApiError(409, "CONFLICT", "This trip is not running right now.");
  }

  const admin = createAdminClient();
  if (claimable) {
    // First driver to send a fix takes an unassigned trip.
    await admin.from("trips").update({ driver_id: user.id }).eq("id", trip.id).is("driver_id", null);
  }

  const now = Date.now();
  const rows: TablesInsert<"trip_locations">[] = [...input.points]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .filter((p) => {
      const t = Date.parse(p.at);
      // Drop clock nonsense (> 10 min ahead or > 1 day behind).
      return Number.isFinite(t) && t <= now + 10 * 60_000 && t >= now - 24 * 3600_000;
    })
    .map((p) => ({
      trip_id: trip.id,
      driver_id: user.id,
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.accuracy ?? null,
      heading: p.heading ?? null,
      speed_mps: p.speed ?? null,
      recorded_at: new Date(p.at).toISOString(),
    }));

  if (rows.length > 0) {
    const { error } = await admin.from("trip_locations").insert(rows);
    if (error) {
      console.error("[driver/location] insert failed:", error.message);
      throw new ApiError(500, "INTERNAL", "Could not save the location.");
    }
    const newest = rows[rows.length - 1]!;
    await runAfterResponse(() => approachingAfterInsert(admin, trip, { lat: newest.lat, lng: newest.lng }));
  }

  return new Response(null, { status: 204 });
});

/** The approaching check never delays or breaks the 204: it runs after the response and swallows its own errors. */
async function approachingAfterInsert(admin: ReturnType<typeof createAdminClient>, trip: Trip, bus: { lat: number; lng: number }): Promise<void> {
  try {
    const settings = await getSettings();
    await notifyApproaching(admin, trip, bus, {
      time: formatTime(trip.departure_at, settings.timezone),
      origin: trip.origin_label,
      destination: trip.destination_label,
      hostel: settings.hostel_name,
    });
  } catch (err) {
    console.error("[driver/location] approaching check failed:", err instanceof Error ? err.message : err);
  }
}

/** `after()` inside a request (returns at once); inline and awaited outside one (scripts, tests). */
function runAfterResponse(task: () => Promise<void>): Promise<void> | void {
  try {
    after(task);
  } catch {
    return task();
  }
}
