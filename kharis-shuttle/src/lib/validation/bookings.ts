import { z } from "zod";
import { optionalText, uuid } from "./common";

export const createBookingSchema = z.object({
  trip_id: uuid,
  pickup_location_id: uuid.optional().nullable(),
  pickup_note: optionalText(140),
  agreed_cash: z.literal(true, { error: "Please agree to pay the driver in cash." }),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const pickupRequestStatusAction = z.enum(["accept", "decline"]);

export const createPickupRequestSchema = z
  .object({
    trip_id: uuid.optional().nullable(),
    direction: z.enum(["to_campus", "to_hostel"]),
    pickup_location_id: uuid.optional().nullable(),
    custom_place: optionalText(120),
    lat: z.number().min(-90).max(90).optional().nullable(),
    lng: z.number().min(-180).max(180).optional().nullable(),
    note: optionalText(200),
  })
  .refine((v) => v.pickup_location_id || v.custom_place || (v.lat != null && v.lng != null), {
    message: "Pick a place or share your location.",
    path: ["custom_place"],
  });
export type CreatePickupRequestInput = z.infer<typeof createPickupRequestSchema>;

export const respondPickupRequestSchema = z.object({
  action: pickupRequestStatusAction,
  note: optionalText(200),
});
export type RespondPickupRequestInput = z.infer<typeof respondPickupRequestSchema>;
