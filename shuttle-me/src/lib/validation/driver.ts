import { z } from "zod";
import { isoDateTime, lat, lng, optionalText, shortText, tripDirection, uuid } from "./common";

export const driverTripStatusSchema = z.object({
  status: z.enum(["boarding", "departed", "arrived", "cancelled"]),
  reason: optionalText(200),
});
export type DriverTripStatusInput = z.infer<typeof driverTripStatusSchema>;

export const locationPointSchema = z.object({
  lat,
  lng,
  accuracy: z.number().min(0).max(100_000).optional().nullable(),
  heading: z.number().min(0).max(360).optional().nullable(),
  speed: z.number().min(0).max(200).optional().nullable(),
  at: isoDateTime,
});
export type LocationPointInput = z.infer<typeof locationPointSchema>;

export const locationBatchSchema = z.object({
  trip_id: uuid,
  points: z.array(locationPointSchema).min(1).max(50),
});
export type LocationBatchInput = z.infer<typeof locationBatchSchema>;

export const announceTripSchema = z.object({
  direction: tripDirection.default("to_hostel"),
  origin_label: shortText(60).min(1, "Where is the shuttle now?"),
  destination_label: shortText(60).optional(),
  leaving_in_minutes: z.number().int().min(0).max(180).default(10),
  seat_capacity: z.number().int().min(1).max(100).optional().nullable(),
  message: optionalText(200),
});
export type AnnounceTripInput = z.infer<typeof announceTripSchema>;

export const riderStatusSchema = z.object({
  status: z.enum(["confirmed", "boarded", "no_show", "cancelled"]),
});
export type RiderStatusInput = z.infer<typeof riderStatusSchema>;
