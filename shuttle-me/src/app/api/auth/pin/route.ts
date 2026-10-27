import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { clearLoginFailures, reserveLoginAttempt, setPin, signInWithPin, verifyPin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { changePinSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

const WRONG_CURRENT_PIN = "Your current PIN is not right.";

/**
 * POST /api/auth/pin — change my own PIN (needs the current one).
 *
 * Lockout: checking the current PIN draws on the same 5-per-15-min budget as
 * sign-in (reserveLoginAttempt → verifyPin → clearLoginFailures), so a signed-in
 * device cannot brute-force the PIN here instead of at /login. Every attempt counts,
 * including one that ends in a 503 because Supabase Auth was busy or unreachable
 * (the attempt is reserved before Auth is asked); only a verified current PIN
 * clears the counter.
 *
 * Session: setPin() uses auth.admin.updateUserById({ password }) and GoTrue deletes
 * EVERY session of the user on an admin password update, so right after a successful
 * change the request's own cookie session is dead. We therefore sign straight back in
 * with the new PIN so the response carries a fresh cookie session. If that re-sign-in
 * fails we still return ok — the PIN did change; the next request gets a 401 and the
 * UI sends the user to /login.
 */
export const POST = withHandler(async (request) => {
  const { user, profile } = await requireUser();
  const input = await parseBody(request, changePinSchema);
  if (input.current_pin === input.new_pin) {
    throw new ApiError(400, "VALIDATION", "Choose a different PIN from your current one.");
  }

  const admin = createAdminClient();
  await reserveLoginAttempt(admin, profile.username);

  try {
    await verifyPin(profile.username, input.current_pin);
  } catch (err) {
    // Same uniform wording for every 401; 503s (Auth busy/down) pass through.
    if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
      throw new ApiError(401, "INVALID_CREDENTIALS", WRONG_CURRENT_PIN);
    }
    throw err;
  }

  await clearLoginFailures(admin, profile.username);
  await setPin(admin, user.id, profile.username, input.new_pin);

  try {
    await signInWithPin(profile.username, input.new_pin);
  } catch (err) {
    console.warn("[auth] re-sign-in after PIN change failed:", err instanceof Error ? err.message : err);
  }

  return ok({ ok: true });
});
