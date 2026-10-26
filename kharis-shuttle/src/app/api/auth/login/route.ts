import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import {
  assertNotLockedOut,
  clearLoginFailures,
  loadProfile,
  publicProfile,
  recordLoginFailure,
  signInWithPin,
  signOutCurrent,
} from "@/lib/auth/session";
import { HOME_BY_ROLE } from "@/lib/constants";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/login — username + PIN → cookie session. */
export const POST = withHandler(async (request) => {
  const input = await parseBody(request, loginSchema);
  const admin = createAdminClient();

  await assertNotLockedOut(admin, input.username);

  try {
    await signInWithPin(input.username, input.pin);
  } catch (err) {
    if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
      await recordLoginFailure(admin, input.username);
    }
    throw err;
  }

  await clearLoginFailures(admin, input.username);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const profile = user ? await loadProfile(admin, user.id) : null;
  if (!profile) {
    await signOutCurrent();
    throw new ApiError(401, "INVALID_CREDENTIALS", "Wrong username or PIN.");
  }
  if (!profile.is_active) {
    await signOutCurrent();
    throw new ApiError(403, "FORBIDDEN", "This account is deactivated. Contact the hostel office.");
  }

  return ok({ profile: publicProfile(profile), home: HOME_BY_ROLE[profile.role] });
});
