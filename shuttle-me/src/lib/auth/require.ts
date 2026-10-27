import type { User } from "@supabase/supabase-js";
import { cache } from "react";
import { ApiError } from "@/lib/api";
import type { Profile, UserRole } from "@/lib/db.types";
import { createClient } from "@/lib/supabase/server";

export type AuthContext = {
  user: User;
  profile: Profile;
};

/**
 * Current user + profile, or null when signed out. Never throws.
 *
 * Memoised per request with React `cache()`: the role layout's guard, the page's
 * guard and anything else in the same render share ONE GoTrue `getUser()` round
 * trip and ONE profile select (each one crosses to the Supabase region). Nothing
 * reads it back after a profile mutation inside the same request (handlers return
 * the row the update itself selected), so a stale copy within a request is fine.
 * Keep `getUser()` here, not `getClaims()`: an admin PIN reset must kill old
 * sessions immediately, and only the server-side check does that.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!profile) return null;
  return { user, profile };
});

/** Throws ApiError(401) when signed out, ApiError(403) when the account is deactivated. */
export async function requireUser(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new ApiError(401, "UNAUTHENTICATED", "Please log in.");
  if (!ctx.profile.is_active) throw new ApiError(403, "FORBIDDEN", "This account is deactivated. Contact the hostel office.");
  return ctx;
}

const ROLE_RANK: Record<UserRole, number> = { student: 0, driver: 1, admin: 2 };

export function hasRole(profile: Pick<Profile, "role">, ...roles: UserRole[]): boolean {
  return roles.includes(profile.role);
}

/** Drivers and admins are "staff". */
export function isStaff(profile: Pick<Profile, "role">): boolean {
  return ROLE_RANK[profile.role] >= ROLE_RANK.driver;
}

/** Admin is allowed everywhere a driver is. */
export async function requireRole(...roles: UserRole[]): Promise<AuthContext> {
  const ctx = await requireUser();
  const allowed = roles.some((r) => ROLE_RANK[ctx.profile.role] >= ROLE_RANK[r]);
  if (!allowed) throw new ApiError(403, "FORBIDDEN", "You don't have access to this.");
  return ctx;
}
