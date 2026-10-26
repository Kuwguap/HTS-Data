import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { derivePassword, secretsEqual, usernameToEmail } from "@/lib/auth/pin";
import { loadProfile, publicProfile, signInWithPin } from "@/lib/auth/session";
import { HOME_BY_ROLE } from "@/lib/constants";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerSchema } from "@/lib/validation/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register
 * Creates a Supabase Auth user behind a synthetic email, the profile row, and
 * signs the new student in. Public signups are disabled in Supabase itself, so
 * this route (service role) is the only way in.
 */
export const POST = withHandler(async (request) => {
  const input = await parseBody(request, registerSchema);
  const admin = createAdminClient();
  const { pinPepper } = serverEnv();

  // Optional hostel join code set by the admin.
  const { data: settings } = await admin.from("settings").select("signup_code").eq("id", 1).maybeSingle();
  const requiredCode = settings?.signup_code?.trim();
  if (requiredCode) {
    if (!input.signup_code || !secretsEqual(input.signup_code.trim().toLowerCase(), requiredCode.toLowerCase())) {
      throw new ApiError(403, "SIGNUP_CODE", "That hostel code is not right. Ask the hostel office for it.");
    }
  }

  const { data: taken } = await admin.from("profiles").select("id").eq("username", input.username).maybeSingle();
  if (taken) throw new ApiError(409, "USERNAME_TAKEN", "That username is taken. Try another one.");

  const { data: created, error } = await admin.auth.admin.createUser({
    email: usernameToEmail(input.username),
    password: derivePassword(input.username, input.pin, pinPepper),
    email_confirm: true,
    user_metadata: {
      username: input.username,
      full_name: input.full_name,
      phone: input.phone,
      room: input.room,
    },
  });
  if (error || !created.user) {
    const msg = error?.message ?? "";
    if (/already|exists|registered/i.test(msg)) {
      throw new ApiError(409, "USERNAME_TAKEN", "That username is taken. Try another one.");
    }
    throw new ApiError(500, "INTERNAL", "Could not create your account. Try again.");
  }

  // The auth.users trigger creates the profile; upsert makes this robust either way.
  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: created.user.id,
      username: input.username,
      full_name: input.full_name,
      phone: input.phone,
      room: input.room,
    },
    { onConflict: "id" },
  );
  if (profileError) {
    // Roll back the auth user so the username is not stuck half-created.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => undefined);
    if (profileError.code === "23505") {
      throw new ApiError(409, "USERNAME_TAKEN", "That username is taken. Try another one.");
    }
    throw new ApiError(500, "INTERNAL", "Could not create your account. Try again.");
  }

  await signInWithPin(input.username, input.pin);
  const profile = await loadProfile(admin, created.user.id);
  if (!profile) throw new ApiError(500, "INTERNAL", "Account created but profile missing. Try logging in.");

  return ok({ profile: publicProfile(profile), home: HOME_BY_ROLE[profile.role] }, { status: 201 });
});
