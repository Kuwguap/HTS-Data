import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import {
  WrongPinError,
  assertNotLockedOut,
  clearLoginFailures,
  setPin,
  signInWithPin,
  throwLoginFailure,
  verifyPin,
} from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { changePinSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

const WRONG_CURRENT_PIN = "Your current PIN is not right.";

/**
 * POST /api/auth/pin — change my own PIN (needs the current one).
 *
 * Lockout: a wrong current PIN counts toward the same 5-per-15-min lockout as
 * sign-in (assertNotLockedOut → verifyPin → throwLoginFailure), so a signed-in
 * device cannot brute-force the PIN here instead of at /login.
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
  await assertNotLockedOut(admin, profile.username);

  try {
    await verifyPin(profile.username, input.current_pin);
  } catch (err) {
    if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
      // Same lockout rule as /login; only a genuinely wrong PIN (WrongPinError) counts.
      const shown = err instanceof WrongPinError ? new WrongPinError(WRONG_CURRENT_PIN) : new ApiError(401, "INVALID_CREDENTIALS", WRONG_CURRENT_PIN);
      await throwLoginFailure(admin, profile.username, shown);
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
