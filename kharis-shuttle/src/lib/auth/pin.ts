import { createHmac, timingSafeEqual } from "node:crypto";
import { PIN_RE, USERNAME_RE } from "@/lib/validation/common";

// Server-only module (node:crypto). Client components import the regexes from
// @/lib/validation/common instead.
export { PIN_RE, USERNAME_RE };
export const SYNTHETIC_EMAIL_DOMAIN = "users.shuttle-me.local";

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

/** Supabase Auth needs an email; usernames map to a synthetic one. */
export function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export function emailToUsername(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return null;
  if (email.slice(at + 1) !== SYNTHETIC_EMAIL_DOMAIN) return null;
  return email.slice(0, at);
}

/**
 * The Supabase Auth password is never the raw PIN. A server-side pepper turns the
 * low-entropy PIN into a 43-char secret, so the only possible attack is online
 * guessing through our own login endpoint (which is rate limited and locks out).
 */
export function derivePassword(username: string, pin: string, pepper: string): string {
  if (!pepper || pepper.length < 16) {
    throw new Error("PIN_PEPPER must be at least 16 characters");
  }
  return createHmac("sha256", pepper).update(`${normalizeUsername(username)}:${pin}`).digest("base64url");
}

/** Constant-time string compare for secrets (cron bearer, signup code). */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;
