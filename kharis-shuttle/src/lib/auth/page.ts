import { redirect } from "next/navigation";
import type { UserRole } from "@/lib/db.types";
import { HOME_BY_ROLE } from "@/lib/constants";
import { getAuthContext, type AuthContext } from "./require";

const RANK: Record<UserRole, number> = { student: 0, driver: 1, admin: 2 };

export type PageAuthOptions = {
  /** Minimum role required (admin ⊇ driver ⊇ student). Default: student. */
  role?: UserRole;
  /** Allow users who have not finished /welcome yet. Default: false. */
  allowUnonboarded?: boolean;
  /** Where to send signed-out visitors. Default: /login?next=<current>. */
  next?: string;
};

/**
 * Server-side guard for pages and layouts. Redirects instead of throwing:
 * signed out → /login, deactivated → /login?deactivated=1, wrong role → their home,
 * not onboarded → /welcome.
 */
export async function requirePageAuth(opts: PageAuthOptions = {}): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) {
    redirect(opts.next ? `/login?next=${encodeURIComponent(opts.next)}` : "/login");
  }
  if (!ctx.profile.is_active) {
    redirect("/login?deactivated=1");
  }
  const required = opts.role ?? "student";
  if (RANK[ctx.profile.role] < RANK[required]) {
    redirect(HOME_BY_ROLE[ctx.profile.role]);
  }
  if (!opts.allowUnonboarded && !ctx.profile.onboarded_at) {
    redirect("/welcome");
  }
  return ctx;
}

/** For /login and /register: send signed-in users straight to their home. */
export async function redirectIfSignedIn(): Promise<void> {
  const ctx = await getAuthContext();
  if (ctx && ctx.profile.is_active) {
    redirect(ctx.profile.onboarded_at ? HOME_BY_ROLE[ctx.profile.role] : "/welcome");
  }
}

export function homeFor(role: UserRole): string {
  return HOME_BY_ROLE[role];
}
