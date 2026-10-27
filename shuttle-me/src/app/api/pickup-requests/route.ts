import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { listMyPickupRequests } from "@/lib/data/student";
import type { TablesInsert, Trip } from "@/lib/db.types";
import { listDriverIds, notifyAndDrain } from "@/lib/notify/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatTime } from "@/lib/time";
import { isTripActive } from "@/lib/trips";
import { createPickupRequestSchema } from "@/lib/validation/bookings";

export const dynamic = "force-dynamic";

/** How long a request waits for a driver before the tick expires it. */
const REQUEST_TTL_MS = 45 * 60_000;
/** Never expire a request sooner than this, even when the trip leaves "now". */
const REQUEST_MIN_TTL_MS = 5 * 60_000;
const PUSH_TTL_SECONDS = 900;
/** A bus that already left is on the road: give the driver at least the push's lifetime to respond. */
const REQUEST_ON_ROAD_TTL_MS = PUSH_TTL_SECONDS * 1000;

/**
 * Expire the rider's pending requests whose expires_at has passed (mirrors step 6 of
 * run_tick in 0005_fn_trips_tick.sql: status → expired, pickup_request_expired to the
 * rider under 'pr_expired:<request id>'). Never throws: a failure here only means the
 * insert may still hit the unique index, which is handled below.
 */
async function expireStalePendingRequests(admin: ReturnType<typeof createAdminClient>, riderId: string, nowMs: number): Promise<void> {
  const { data: expired, error } = await admin
    .from("pickup_requests")
    .update({ status: "expired" })
    .eq("rider_id", riderId)
    .eq("status", "pending")
    .lte("expires_at", new Date(nowMs).toISOString())
    .select("id, rider_id, pickup_location_id, custom_place");
  if (error) {
    console.error("[pickup-requests] expiring stale requests failed:", error.message);
    return;
  }
  for (const req of expired ?? []) {
    let pickup: string | null = null;
    if (req.pickup_location_id) {
      const { data: loc } = await admin.from("pickup_locations").select("name").eq("id", req.pickup_location_id).maybeSingle();
      pickup = loc?.name ?? null;
    }
    await notifyAndDrain(admin, {
      userIds: [req.rider_id],
      kind: "pickup_request_expired",
      vars: { pickup: pickup ?? req.custom_place ?? "your pickup point", request_id: req.id },
      url: `/app/requests/${req.id}`,
      dedupePrefix: `pr_expired:${req.id}`,
      ttlSeconds: 3600,
      urgency: "normal",
      collapseTag: `request:${req.id}`,
    });
  }
}

/** GET /api/pickup-requests — my requests, newest first. */
export const GET = withHandler(async () => {
  const { user } = await requireUser();
  const requests = await listMyPickupRequests(user.id);
  return ok({ requests });
});

/**
 * POST /api/pickup-requests — ask the driver to pick me up somewhere.
 * Body: createPickupRequestSchema. One pending request at a time (409 CONFLICT
 * with details.request_id otherwise). Pushes pickup_request_new to the trip's
 * driver, or every active driver. Response: { request }.
 */
export const POST = withHandler(async (request) => {
  const { user, profile } = await requireUser();
  const input = await parseBody(request, createPickupRequestSchema);
  const admin = createAdminClient();
  const settings = await getSettings();
  const now = Date.now();

  let trip: Trip | null = null;
  if (input.trip_id) {
    const { data } = await admin.from("trips").select("*").eq("id", input.trip_id).maybeSingle();
    if (!data || !isTripActive(data)) {
      throw new ApiError(409, "TRIP_NOT_OPEN", "That departure is no longer running. Pick another one.");
    }
    if (data.direction !== input.direction) {
      throw new ApiError(400, "VALIDATION", "Please check the form.", {
        fieldErrors: { trip_id: ["That departure goes the other way."] },
      });
    }
    trip = data;
  }

  let pickupName: string | null = null;
  if (input.pickup_location_id) {
    const { data: loc } = await admin
      .from("pickup_locations")
      .select("name, direction, is_active")
      .eq("id", input.pickup_location_id)
      .maybeSingle();
    if (!loc || !loc.is_active || (loc.direction && loc.direction !== input.direction)) {
      throw new ApiError(409, "PICKUP_INVALID", "Pick a valid pickup point for this direction.");
    }
    pickupName = loc.name;
  }

  // The partial unique index pickup_requests_one_pending ignores expires_at, so a pending
  // request whose expires_at passed (the tick has not run yet) would make the insert below
  // fail with 23505 and point the rider at a dead request. Expire the caller's own stale
  // rows first, exactly the way run_tick does (same kind, vars and 'pr_expired:' prefix,
  // so the tick cannot send the expiry a second time).
  await expireStalePendingRequests(admin, user.id, now);

  const { data: pending } = await admin
    .from("pickup_requests")
    .select("id")
    .eq("rider_id", user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date(now).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pending) {
    throw new ApiError(409, "CONFLICT", "You already have a request waiting for the driver.", { request_id: pending.id });
  }

  let expiresMs = now + REQUEST_TTL_MS;
  if (trip) {
    const departure = new Date(trip.departure_at).getTime();
    const onRoad = trip.status === "boarding" || trip.status === "departed" || departure <= now;
    const floor = now + (onRoad ? REQUEST_ON_ROAD_TTL_MS : REQUEST_MIN_TTL_MS);
    expiresMs = Math.min(expiresMs, Math.max(departure, floor));
  }

  const row: TablesInsert<"pickup_requests"> = {
    rider_id: user.id,
    trip_id: trip?.id ?? null,
    direction: input.direction,
    pickup_location_id: input.pickup_location_id ?? null,
    custom_place: input.custom_place ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    note: input.note ?? null,
    status: "pending",
    expires_at: new Date(expiresMs).toISOString(),
  };
  const { data: created, error } = await admin.from("pickup_requests").insert(row).select("*").single();
  if (error?.code === "23505") {
    // Lost the race against a double tap: the partial unique index allows one pending request.
    const { data: existing } = await admin
      .from("pickup_requests")
      .select("id")
      .eq("rider_id", user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    throw new ApiError(409, "CONFLICT", "You already have a request waiting for the driver.", {
      request_id: existing?.id ?? null,
    });
  }
  if (error || !created) throw new ApiError(500, "INTERNAL", "Could not send your request. Try again.");

  const place =
    pickupName ??
    created.custom_place ??
    (created.lat != null && created.lng != null ? `${created.lat.toFixed(5)}, ${created.lng.toFixed(5)}` : "a custom spot");
  const drivers = await listDriverIds(admin, trip?.driver_id ?? settings.default_driver_id);
  await notifyAndDrain(admin, {
    userIds: drivers,
    kind: "pickup_request_new",
    vars: {
      name: profile.full_name,
      pickup: place,
      message: [trip ? `For the ${formatTime(trip.departure_at, settings.timezone)} shuttle.` : null, created.note].filter(Boolean).join(" "),
      time: trip ? formatTime(trip.departure_at, settings.timezone) : "",
    },
    url: "/driver/requests",
    dedupePrefix: `pickup_request_new:${created.id}`,
    ttlSeconds: PUSH_TTL_SECONDS,
    urgency: "high",
    collapseTag: `pr:${created.id}`,
  });

  return ok({ request: created });
});
