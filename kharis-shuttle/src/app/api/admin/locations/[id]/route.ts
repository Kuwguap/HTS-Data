import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import type { TablesUpdate } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { pickupLocationPatchSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/locations/:id — edit a pickup point (pickupLocationPatchSchema). */
export const PATCH = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, pickupLocationPatchSchema);
  // Forward only the keys the body carried: an absent key must never reset its column.
  const patch: TablesUpdate<"pickup_locations"> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.direction !== undefined) patch.direction = input.direction;
  if (input.lat !== undefined) patch.lat = input.lat;
  if (input.lng !== undefined) patch.lng = input.lng;
  if (input.sort_order !== undefined) patch.sort_order = input.sort_order;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (Object.keys(patch).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to change.");
  const admin = createAdminClient();
  const { data, error } = await admin.from("pickup_locations").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Pickup point not found.");
  return ok({ location: data });
});

/**
 * DELETE /api/admin/locations/:id — delete a pickup point; when bookings or
 * pickup requests reference it, it is deactivated instead (history stays intact).
 */
export const DELETE = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const admin = createAdminClient();

  const [{ count: bookings }, { count: requests }] = await Promise.all([
    admin.from("bookings").select("id", { count: "exact", head: true }).eq("pickup_location_id", id),
    admin.from("pickup_requests").select("id", { count: "exact", head: true }).eq("pickup_location_id", id),
  ]);

  if ((bookings ?? 0) > 0 || (requests ?? 0) > 0) {
    const { data, error } = await admin.from("pickup_locations").update({ is_active: false }).eq("id", id).select("*").maybeSingle();
    if (error) throw fromPostgresError(error);
    if (!data) throw new ApiError(404, "NOT_FOUND", "Pickup point not found.");
    return ok({ deleted: false, deactivated: true, location: data });
  }

  const { data, error } = await admin.from("pickup_locations").delete().eq("id", id).select("id").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Pickup point not found.");
  return ok({ deleted: true, deactivated: false, id });
});
