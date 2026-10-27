import type { User } from "@supabase/supabase-js";
import { ApiError } from "@/lib/api";
import type { Profile, UserRole } from "@/lib/db.types";
import { createClient } from "@/lib/supabase/server";

export type AuthContext = {
  user: User;
  profile: Profile;
};

/** Current user + profile, or null when signed out. Never throws. */
export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!profile) return null;
  return { user, profile };
}

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
