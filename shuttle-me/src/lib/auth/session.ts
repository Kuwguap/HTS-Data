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
 * Supabase Auth checked the username + PIN and rejected them. Every other 401 (an
 * auth code we do not know, e.g. a banned user) is reported with the same message
 * so nothing about the account leaks.
 */
export class WrongPinError extends ApiError {
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

/**
 * The 423 LOCKED error for a lock that is still in force, or null when not locked.
 * `asOf` is the database's idea of "now" (login_attempts.updated_at, written with
 * now() on every record_login_failure call) so the lock is judged on the same clock
 * that set it; without it, or when it does not parse, the Node clock is used.
 * The wording says "sign-in attempts", not "wrong attempts": every reservation counts
 * toward the budget, including attempts that ended in a 503 from Supabase Auth.
 */
export function lockoutError(lockedUntil: string | null | undefined, asOf?: string | null): ApiError | null {
  if (!lockedUntil) return null;
  const asOfMs = asOf ? new Date(asOf).getTime() : Number.NaN;
  const nowMs = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const remainingMs = new Date(lockedUntil).getTime() - nowMs;
  if (!(remainingMs > 0)) return null;
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return new ApiError(
    423,
    "LOCKED",
    `Too many sign-in attempts. Try again in ${minutes} min or ask the hostel office to reset your PIN.`,
  );
}

/**
 * Reserve one PIN check BEFORE asking Supabase Auth. One atomic call to
 * record_login_failure (migration 0010: a single INSERT ... ON CONFLICT DO UPDATE),
 * so a parallel burst cannot out-race the lockout: the window allows exactly
 * LOGIN_MAX_FAILURES verified guesses, the next attempt trips the lock and is refused
 * here without reaching GoTrue, and so is every attempt while the lock holds.
 * A successful check clears the row (clearLoginFailures), so correct PINs cost nothing.
 * Every reservation counts, whatever happens next (a 503 from Supabase Auth included).
 * Fails closed: if the counter cannot be written the check is refused with 503
 * rather than running unthrottled.
 * The lock is judged against the row's updated_at (the database clock that set
 * locked_until), not the Node clock.
 */
export async function reserveLoginAttempt(admin: Admin, username: string): Promise<LoginAttempt> {
  const { data, error } = await admin.rpc("record_login_failure", {
    p_username: normalizeUsername(username),
    p_max_failures: LOGIN_MAX_FAILURES + 1,
    p_lockout_minutes: LOGIN_LOCKOUT_MINUTES,
  });
  if (error || !data) {
    console.error("[auth] record_login_failure failed:", error?.message ?? "no row returned");
    throw new ApiError(503, "INTERNAL", SIGN_IN_UNREACHABLE_MESSAGE);
  }
  const locked = lockoutError(data.locked_until, data.updated_at);
  if (locked) throw locked;
  return data;
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
