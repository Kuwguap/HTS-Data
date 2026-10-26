import { ApiError, fromPostgresError, ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { settingsSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** GET /api/admin/settings — the settings singleton. */
export const GET = withHandler(async () => {
  await requireRole("admin");
  const settings = await getSettings();
  return ok({ settings });
});

/** PUT /api/admin/settings — replace every editable field (settingsSchema). */
export const PUT = withHandler(async (request) => {
  const { user } = await requireRole("admin");
  const input = await parseBody(request, settingsSchema);
  const admin = createAdminClient();

  if (input.default_driver_id) {
    const { data: driver } = await admin
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", input.default_driver_id)
      .maybeSingle();
    if (!driver || !driver.is_active || driver.role === "student") {
      throw new ApiError(400, "VALIDATION", "Please check the form.", {
        fieldErrors: { default_driver_id: ["Pick an active driver"] },
      });
    }
  }

  const { data, error } = await admin
    .from("settings")
    .upsert({ id: 1, ...input, default_driver_id: input.default_driver_id ?? null, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "id" })
    .select("*")
    .single();
  if (error || !data) throw fromPostgresError(error);
  return ok({ settings: data });
});
