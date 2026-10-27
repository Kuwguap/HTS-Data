import { z } from "zod";
import { isoDate, isoDateTime, lat, lng, optionalText, shortText, timeOfDay, tripDirection, userRole, uuid } from "./common";

export const settingsSchema = z.object({
  hostel_name: shortText(80).min(2),
  campus_name: shortText(80).min(1),
  timezone: shortText(60)
    .min(1)
    .refine((tz) => isValidTimeZone(tz), { message: "Not a valid time zone (e.g. Africa/Accra)." }),
  fare_pesewas: z.number().int().min(0).max(1_000_000),
  currency: shortText(8).min(1),
  payment_note: shortText(200),
  enquiry_phone: optionalText(30),
  default_seat_capacity: z.number().int().min(1).max(100),
  reminder_lead_minutes: z.number().int().min(5).max(24 * 60),
  nudge_minutes: z.number().int().min(0).max(120),
  manifest_lead_minutes: z.number().int().min(0).max(240),
  booking_cutoff_minutes: z.number().int().min(0).max(120),
  booking_open_days_ahead: z.number().int().min(0).max(7),
  daily_announcement_enabled: z.boolean(),
  daily_announcement_time: timeOfDay,
  // trips.last_* is refreshed at most every 15 s (0007), so anything under 45 s makes
  // the LIVE chip flap between fixes. The DB check only requires > 0; the default is 90.
  location_stale_seconds: z.number().int().min(45).max(3600),
  signup_code: optionalText(40),
  default_driver_id: uuid.optional().nullable(),
});
export type SettingsInput = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

// Patch schemas are built from default-free shapes: zod 4's `.partial()` still applies
// `.default()` values, which would turn `{ is_active: false }` into a reset of other columns.
const scheduleTimeShape = {
  direction: tripDirection,
  depart_time: timeOfDay,
  days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  label: optionalText(60),
  seat_capacity: z.number().int().min(1).max(100).optional().nullable(),
  bookings_enabled: z.boolean(),
  is_active: z.boolean(),
};
export const scheduleTimeSchema = z.object({
  ...scheduleTimeShape,
  bookings_enabled: z.boolean().default(true),
  is_active: z.boolean().default(true),
});
export type ScheduleTimeInput = z.infer<typeof scheduleTimeSchema>;
export const scheduleTimePatchSchema = z
  .object(scheduleTimeShape)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update." });
export type ScheduleTimePatchInput = z.infer<typeof scheduleTimePatchSchema>;

const pickupLocationShape = {
  name: shortText(80).min(1),
  description: optionalText(200),
  direction: tripDirection.optional().nullable(),
  lat,
  lng,
  sort_order: z.number().int().min(0).max(1000),
  is_active: z.boolean(),
};
export const pickupLocationSchema = z.object({
  ...pickupLocationShape,
  sort_order: z.number().int().min(0).max(1000).default(0),
  is_active: z.boolean().default(true),
});
export type PickupLocationInput = z.infer<typeof pickupLocationSchema>;
export const pickupLocationPatchSchema = z
  .object(pickupLocationShape)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update." });
export type PickupLocationPatchInput = z.infer<typeof pickupLocationPatchSchema>;

/** IANA zone check used by the settings route. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const dayOffSchema = z.object({
  service_date: isoDate,
  reason: optionalText(120),
});

export const templateSchema = z.object({
  title: shortText(120).min(1),
  body: shortText(500).min(1),
});

export const userRoleSchema = z.object({ role: userRole });
export const userActiveSchema = z.object({ is_active: z.boolean() });

export const tripPatchSchema = z.object({
  seat_capacity: z.number().int().min(1).max(100).optional(),
  driver_id: uuid.optional().nullable(),
  bookings_enabled: z.boolean().optional(),
  departure_at: isoDateTime.optional(),
  origin_label: shortText(60).optional(),
  destination_label: shortText(60).optional(),
});
export type TripPatchInput = z.infer<typeof tripPatchSchema>;

export const tripCancelSchema = z.object({
  reason: shortText(200).min(1, "Tell riders why"),
});

export const adhocTripSchema = z.object({
  direction: tripDirection,
  origin_label: shortText(60).min(1),
  destination_label: shortText(60).min(1),
  departure_at: isoDateTime,
  seat_capacity: z.number().int().min(1).max(100).optional().nullable(),
  driver_id: uuid.optional().nullable(),
  notify: z.boolean().default(false),
});
export type AdhocTripInput = z.infer<typeof adhocTripSchema>;

export const broadcastSchema = z.object({
  title: shortText(80).min(1),
  message: shortText(400).min(1),
  audience: z.enum(["all", "students", "drivers"]).default("students"),
  url: z.string().max(200).optional().nullable(),
});
export type BroadcastInput = z.infer<typeof broadcastSchema>;

export const reportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
