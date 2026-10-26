import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { setPin, verifyPin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { changePinSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/pin — change my own PIN (needs the current one). */
export const POST = withHandler(async (request) => {
  const { user, profile } = await requireUser();
  const input = await parseBody(request, changePinSchema);

  const valid = await verifyPin(profile.username, input.current_pin);
  if (!valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Your current PIN is not right.");
  if (input.current_pin === input.new_pin) {
    throw new ApiError(400, "VALIDATION", "Choose a different PIN from your current one.");
  }

  await setPin(createAdminClient(), user.id, profile.username, input.new_pin);
  return ok({ ok: true });
});
