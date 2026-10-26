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

/** Uniform message so usernames cannot be enumerated. */
export const INVALID_CREDENTIALS_MESSAGE = "Wrong username or PIN.";

/**
 * Sign the current request's cookie session in with a username + PIN.
 * Throws ApiError(401) on failure; the caller records the failed attempt.
 */
export async function signInWithPin(username: string, pin: string): Promise<void> {
  const { pinPepper } = serverEnv();
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: usernameToEmail(username),
    password: derivePassword(username, pin, pinPepper),
  });
  if (error) {
    throw new ApiError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
  }
}

/**
 * Verify a username + PIN WITHOUT touching the request's cookies (used for
 * "change PIN"). Uses a throwaway client that never persists its session.
 */
export async function verifyPin(username: string, pin: string): Promise<boolean> {
  const { pinPepper } = serverEnv();
  const bare = createBareClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await bare.auth.signInWithPassword({
    email: usernameToEmail(username),
    password: derivePassword(username, pin, pinPepper),
  });
  if (error || !data.session) return false;
  // Best effort: revoke the throwaway session so it does not linger server-side.
  await bare.auth.signOut({ scope: "local" }).catch(() => undefined);
  return true;
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

/** Throws ApiError(423) when the username is locked out. */
export async function assertNotLockedOut(admin: Admin, username: string): Promise<void> {
  const { data } = await admin
    .from("login_attempts")
    .select("failed_count, locked_until")
    .eq("username", normalizeUsername(username))
    .maybeSingle();
  if (data?.locked_until && new Date(data.locked_until).getTime() > Date.now()) {
    const minutes = Math.max(1, Math.ceil((new Date(data.locked_until).getTime() - Date.now()) / 60_000));
    throw new ApiError(
      423,
      "LOCKED",
      `Too many wrong attempts. Try again in ${minutes} min or ask the hostel office to reset your PIN.`,
    );
  }
}

export async function recordLoginFailure(admin: Admin, username: string): Promise<void> {
  const key = normalizeUsername(username);
  const { data } = await admin.from("login_attempts").select("failed_count").eq("username", key).maybeSingle();
  const failed = (data?.failed_count ?? 0) + 1;
  const lockedUntil =
    failed >= LOGIN_MAX_FAILURES ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60_000).toISOString() : null;
  await admin.from("login_attempts").upsert(
    {
      username: key,
      failed_count: lockedUntil ? 0 : failed,
      locked_until: lockedUntil,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "username" },
  );
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
