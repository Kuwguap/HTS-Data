import { fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listSchedule } from "@/lib/data/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleTimeSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** GET /api/admin/schedule — every schedule time (active or not). */
export const GET = withHandler(async () => {
  await requireRole("admin");
  return ok({ schedule: await listSchedule() });
});

/** POST /api/admin/schedule — add a departure (scheduleTimeSchema). Trips start from the next tick. */
export const POST = withHandler(async (request) => {
  await requireRole("admin");
  const input = await parseBody(request, scheduleTimeSchema);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("schedule_times")
    .insert({ ...input, days_of_week: [...new Set(input.days_of_week)].sort((a, b) => a - b), seat_capacity: input.seat_capacity ?? null })
    .select("*")
    .single();
  if (error || !data) throw fromPostgresError(error);
  return ok({ schedule_time: data });
});
