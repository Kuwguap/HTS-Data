import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/require";
import { HOME_BY_ROLE } from "@/lib/constants";
import { safeNextPath } from "@/lib/validation/common";

/** First value of a Next.js searchParams entry. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * For /login and /register: validate `?next=` and, when the visitor is already
 * signed in (and active), send them on — onboarded users to `next` (else their
 * role home), unonboarded ones through /welcome, which forwards `next` after
 * onboarding. Returns the validated `next` (or undefined when none was given)
 * for the page to hand to its form.
 */
export async function redirectSignedInOrGetNext(rawNext: string | string[] | undefined): Promise<string | undefined> {
  // Empty fallback: an unsafe value is dropped (undefined) so the role home applies.
  const next = safeNextPath(firstParam(rawNext), "") || undefined;
  const ctx = await getAuthContext();
  if (ctx && ctx.profile.is_active) {
    if (!ctx.profile.onboarded_at) {
      redirect(next ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome");
    }
    redirect(next ?? HOME_BY_ROLE[ctx.profile.role]);
  }
  return next;
}
