import { ApiError, fromPostgresError, ok, parseBody, withHandler, type RouteCtx } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import type { TablesUpdate } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleTimePatchSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/schedule/:id — edit a departure (scheduleTimePatchSchema). Today's trips keep their old values. */
export const PATCH = withHandler<RouteCtx<{ id: string }>>(async (request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const input = await parseBody(request, scheduleTimePatchSchema);
  // Forward only the keys the body carried: an absent key must never reset its column.
  const patch: TablesUpdate<"schedule_times"> = {};
  if (input.direction !== undefined) patch.direction = input.direction;
  if (input.depart_time !== undefined) patch.depart_time = input.depart_time;
  if (input.days_of_week !== undefined) patch.days_of_week = [...new Set(input.days_of_week)].sort((a, b) => a - b);
  if (input.label !== undefined) patch.label = input.label;
  if (input.seat_capacity !== undefined) patch.seat_capacity = input.seat_capacity;
  if (input.bookings_enabled !== undefined) patch.bookings_enabled = input.bookings_enabled;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (Object.keys(patch).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to change.");

  const admin = createAdminClient();
  const { data, error } = await admin.from("schedule_times").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Departure not found.");
  return ok({ schedule_time: data });
});

/** DELETE /api/admin/schedule/:id — remove a departure. Existing trips stay (their schedule_time_id becomes null). */
export const DELETE = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const admin = createAdminClient();
  const { data, error } = await admin.from("schedule_times").delete().eq("id", id).select("id").maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Departure not found.");
  return ok({ deleted: true, id });
});
