import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import {
  clearLoginFailures,
  loadProfile,
  publicProfile,
  reserveLoginAttempt,
  signInWithPin,
  signOutCurrent,
} from "@/lib/auth/session";
import { HOME_BY_ROLE } from "@/lib/constants";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login — username + PIN → cookie session.
 * Every attempt is counted atomically BEFORE Supabase Auth is asked, so a burst of
 * parallel guesses gets at most LOGIN_MAX_FAILURES real checks per lockout window;
 * once the window is spent the response is 423 LOCKED without touching Auth.
 * Every attempt draws on that budget, including one that ends in a 503 because
 * Supabase Auth was busy or unreachable — which is why the lockout message says
 * "sign-in attempts", not "wrong attempts". A correct PIN clears the counter.
 * A Supabase outage or rate limit surfaces as 503.
 */
export const POST = withHandler(async (request) => {
  const input = await parseBody(request, loginSchema);
  const admin = createAdminClient();

  await reserveLoginAttempt(admin, input.username);
  await signInWithPin(input.username, input.pin);
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
