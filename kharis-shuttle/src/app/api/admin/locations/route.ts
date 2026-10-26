import { fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listLocations } from "@/lib/data/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { pickupLocationSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** GET /api/admin/locations — every pickup point (active or not). */
export const GET = withHandler(async () => {
  await requireRole("admin");
  return ok({ locations: await listLocations() });
});

/** POST /api/admin/locations — add a pickup point (pickupLocationSchema). */
export const POST = withHandler(async (request) => {
  await requireRole("admin");
  const input = await parseBody(request, pickupLocationSchema);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("pickup_locations")
    .insert({ ...input, direction: input.direction ?? null })
    .select("*")
    .single();
  if (error || !data) throw fromPostgresError(error);
  return ok({ location: data });
});
