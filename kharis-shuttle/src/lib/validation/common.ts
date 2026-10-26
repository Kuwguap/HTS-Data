import { z } from "zod";

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
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
