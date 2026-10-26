import { z } from "zod";

// Browser-safe constants (no node:crypto here) shared by forms and route handlers.
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const PIN_RE = /^\d{4,6}$/;

export const uuid = z.uuid();
export const isoDateTime = z.iso.datetime({ offset: true });
export const isoDate = z.iso.date();
/** "HH:MM" or "HH:MM:SS" (24h). */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use HH:MM");
export const lat = z.number().min(-90).max(90);
export const lng = z.number().min(-180).max(180);
export const tripDirection = z.enum(["to_campus", "to_hostel"]);
export const userRole = z.enum(["student", "driver", "admin"]);
export const shortText = (max: number) => z.string().trim().max(max);

/**
 * Optional free text: an OMITTED key stays omitted (so PATCH bodies only touch the
 * fields they carry); an empty string or null becomes null.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null));

/**
 * Validate a post-login `next` path: must be a same-origin absolute path.
 * Rejects protocol-relative (`//`), backslash tricks (`/\evil.com`), and anything
 * the URL parser would resolve to another origin.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/app"): string {
  if (!raw) return fallback;
  const value = raw.trim();
  if (!value.startsWith("/") || /^\/[\/\\]/.test(value) || /[\\\s]/.test(value)) return fallback;
  try {
    const u = new URL(value, "http://local.test");
    if (u.origin !== "http://local.test") return fallback;
    return `${u.pathname}${u.search}${u.hash}` || fallback;
  } catch {
    return fallback;
  }
}
