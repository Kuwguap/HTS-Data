import "server-only";

import { createClient as createBareClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Profile } from "@/lib/db.types";
import { publicEnv, serverEnv } from "@/lib/env";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { ApiError } from "@/lib/api";
import {
  LOGIN_LOCKOUT_MINUTES,
  LOGIN_MAX_FAILURES,
  derivePassword,
  normalizeUsername,
  usernameToEmail,
} from "./pin";

type Admin = SupabaseClient<Database>;
export type LoginAttempt = Database["public"]["Tables"]["login_attempts"]["Row"];

/** Uniform message so usernames cannot be enumerated. */
export const INVALID_CREDENTIALS_MESSAGE = "Wrong username or PIN.";
const SIGN_IN_UNREACHABLE_MESSAGE = "Can't reach the sign-in service. Try again.";

/**
 * The one sign-in failure that counts toward the lockout: Supabase Auth checked the
 * username + PIN and rejected them. Every other 401 (an auth code we do not know,
 * e.g. a banned user) is reported the same way but is NOT the caller guessing.
 */
export class WrongPinError extends ApiError {
  readonly countsAsFailure = true as const;
  constructor(message = INVALID_CREDENTIALS_MESSAGE) {
    super(401, "INVALID_CREDENTIALS", message);
  }
}

/** The parts of a Supabase AuthError we map on (duck-typed so tests need no auth-js). */
export type SignInFailure = { name?: string; status?: number; code?: string };

/**
 * Map a Supabase `signInWithPassword` error to what the client should see.
 * Only `invalid_credentials` is the user's fault; the Auth service being down or its
 * per-IP sign-in rate limit (every resident shares the server's egress IP) must not
 * read as "Wrong username or PIN" nor count toward the lockout.
 */
export function mapSignInError(error: SignInFailure): ApiError {
  const { name, status, code } = error;
  if (code === "invalid_credentials" || (status === 400 && !code)) return new WrongPinError();
  if (status === 429 || code === "over_request_rate_limit") {
    return new ApiError(503, "RATE_LIMITED", "Sign-in is busy right now. Try again in a minute.");
  }
  // AuthRetryableFetchError carries status 0; a fetch failure has none at all.
  if (name === "AuthRetryableFetchError" || !status || status >= 500) {
    return new ApiError(503, "INTERNAL", SIGN_IN_UNREACHABLE_MESSAGE);
  }
  return new ApiError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
}

/**
 * Sign the current request's cookie session in with a username + PIN.
 * Throws the mapped ApiError on failure (401 WrongPinError when the PIN is wrong,
 * 503 when Supabase Auth is busy or unreachable); the caller records the failure.
 */
export async function signInWithPin(username: string, pin: string): Promise<void> {
  const { pinPepper } = serverEnv();
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: usernameToEmail(username),
    password: derivePassword(username, pin, pinPepper),
  });
  if (error) throw mapSignInError(error);
}

/**
 * Verify a username + PIN WITHOUT touching the request's cookies (used for
 * "change PIN"). Uses a throwaway client that never persists its session.
 * Throws exactly like signInWithPin (WrongPinError for a wrong PIN, 503 when the
 * sign-in service is busy or down) so a Supabase outage is never reported as a
 * wrong current PIN.
 */
export async function verifyPin(username: string, pin: string): Promise<void> {
  const { pinPepper } = serverEnv();
  const bare = createBareClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await bare.auth.signInWithPassword({
    email: usernameToEmail(username),
    password: derivePassword(username, pin, pinPepper),
  });
  if (error) throw mapSignInError(error);
  if (!data.session) throw new ApiError(503, "INTERNAL", SIGN_IN_UNREACHABLE_MESSAGE);
  // Best effort: revoke the throwaway session so it does not linger server-side.
  await bare.auth.signOut({ scope: "local" }).catch(() => undefined);
}

export async function signOutCurrent(): Promise<void> {
  const supabase = await createServerClient();
  await supabase.auth.signOut({ scope: "local" });
}

/** Set a user's Supabase Auth password from a PIN (admin reset / change PIN). */
export async function setPin(admin: Admin, userId: string, username: string, pin: string): Promise<void> {
  const { pinPepper } = serverEnv();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: derivePassword(username, pin, pinPepper),
  });
  if (error) throw new ApiError(500, "INTERNAL", "Could not update the PIN. Try again.");
}

/** The 423 LOCKED error for a lock that is still in force, or null when not locked. */
export function lockoutError(lockedUntil: string | null | undefined): ApiError | null {
  if (!lockedUntil) return null;
  const remainingMs = new Date(lockedUntil).getTime() - Date.now();
  if (!(remainingMs > 0)) return null;
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return new ApiError(
    423,
    "LOCKED",
    `Too many wrong attempts. Try again in ${minutes} min or ask the hostel office to reset your PIN.`,
  );
}

/** Cheap pre-check before hitting Supabase Auth: throws ApiError(423) when the username is locked out. */
export async function assertNotLockedOut(admin: Admin, username: string): Promise<void> {
  const { data } = await admin
    .from("login_attempts")
    .select("locked_until")
    .eq("username", normalizeUsername(username))
    .maybeSingle();
  const locked = lockoutError(data?.locked_until);
  if (locked) throw locked;
}

/**
 * Count one wrong PIN atomically (migration 0010: a single INSERT ... ON CONFLICT
 * DO UPDATE, so parallel requests cannot out-race the lockout) and return the row.
 * Returns null if the database call failed (logged); the caller still reports the
 * original 401.
 */
export async function recordLoginFailure(admin: Admin, username: string): Promise<LoginAttempt | null> {
  const { data, error } = await admin.rpc("record_login_failure", {
    p_username: normalizeUsername(username),
    p_max_failures: LOGIN_MAX_FAILURES,
    p_lockout_minutes: LOGIN_LOCKOUT_MINUTES,
  });
  if (error) {
    console.error("[auth] record_login_failure failed:", error.message);
    return null;
  }
  return data ?? null;
}

/**
 * Handle a failed PIN check: when `err` is a WrongPinError, record the failure and
 * throw the 423 LOCKED error if this attempt tripped the lockout. Any other error
 * (503 outage, unknown auth code) is rethrown untouched and NOT counted.
 */
export async function throwLoginFailure(admin: Admin, username: string, err: unknown): Promise<never> {
  if (err instanceof WrongPinError) {
    const attempt = await recordLoginFailure(admin, username);
    const locked = lockoutError(attempt?.locked_until);
    if (locked) throw locked;
  }
  throw err;
}

export async function clearLoginFailures(admin: Admin, username: string): Promise<void> {
  await admin.from("login_attempts").delete().eq("username", normalizeUsername(username));
}

/** Profile by id via the service role (used right after sign-in before RLS cookies settle). */
export async function loadProfile(admin: Admin, userId: string): Promise<Profile | null> {
  const { data } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data ?? null;
}

/** The subset of a profile that is safe to send to the client. */
export function publicProfile(p: Profile) {
  return {
    id: p.id,
    username: p.username,
    full_name: p.full_name,
    phone: p.phone,
    room: p.room,
    role: p.role,
    reminders_enabled: p.reminders_enabled,
    onboarded_at: p.onboarded_at,
  };
}
export type PublicProfile = ReturnType<typeof publicProfile>;
