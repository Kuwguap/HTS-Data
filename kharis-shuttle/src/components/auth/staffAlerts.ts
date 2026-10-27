import type { UserRole } from "@/lib/db.types";

/**
 * Copy for the static "Trip alerts" row shown to drivers and admins instead of the
 * reminders switch. Manifests, booking changes and pickup requests are duty alerts:
 * delivery never reads `reminders_enabled` for staff, so there is nothing to toggle.
 */
export const STAFF_ALERTS_TITLE = "🔔 Trip alerts";

export function staffAlertsSubtitle(role: UserRole): string {
  return `Always on for ${role === "admin" ? "staff" : "drivers"} — rider lists, booking changes and pickup requests`;
}
