import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { publicProfile } from "@/lib/auth/session";
import { HOME_BY_ROLE } from "@/lib/constants";
import type { TablesUpdate } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { updateProfileSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

/** GET /api/me — who am I (profile + home route). */
export const GET = withHandler(async () => {
  const { profile } = await requireUser();
  return ok({ profile: publicProfile(profile), home: HOME_BY_ROLE[profile.role] });
});

/** PATCH /api/me — update own name/phone/room/reminders; `onboarded: true` stamps onboarded_at. */
export const PATCH = withHandler(async (request) => {
  const { user, profile } = await requireUser();
  const input = await parseBody(request, updateProfileSchema);

  const patch: TablesUpdate<"profiles"> = {};
  if (input.full_name !== undefined) patch.full_name = input.full_name;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.room !== undefined) patch.room = input.room;
  // Only students have a reminders preference. Driver/admin alerts (manifests, booking
  // changes, pickup requests) are duty alerts that delivery sends regardless, so the
  // flag is ignored for staff to keep the stored value meaningless-but-harmless.
  if (input.reminders_enabled !== undefined && profile.role === "student") patch.reminders_enabled = input.reminders_enabled;
  if (input.onboarded) patch.onboarded_at = new Date().toISOString();

  // Nothing left to write (e.g. staff sending only reminders_enabled): answer with
  // the current profile instead of issuing an empty UPDATE.
  if (Object.keys(patch).length === 0) {
    return ok({ profile: publicProfile(profile), home: HOME_BY_ROLE[profile.role] });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.from("profiles").update(patch).eq("id", user.id).select("*").single();
  if (error || !data) throw new ApiError(500, "INTERNAL", "Could not save your details. Try again.");
  return ok({ profile: publicProfile(data), home: HOME_BY_ROLE[data.role] });
});
