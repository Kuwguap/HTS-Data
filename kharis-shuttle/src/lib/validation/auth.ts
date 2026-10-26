import { z } from "zod";
import { PIN_RE, USERNAME_RE } from "@/lib/auth/pin";
import { optionalText } from "./common";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_RE, "3–20 letters, numbers or underscores");

export const pinSchema = z.string().trim().regex(PIN_RE, "PIN must be 4–6 digits");

export const registerSchema = z.object({
  username: usernameSchema,
  full_name: z.string().trim().min(2, "Enter your full name").max(80),
  pin: pinSchema,
  phone: optionalText(30),
  room: optionalText(20),
  signup_code: optionalText(40),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: usernameSchema,
  pin: pinSchema,
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePinSchema = z.object({
  current_pin: pinSchema,
  new_pin: pinSchema,
});

export const adminResetPinSchema = z.object({
  pin: pinSchema,
});

export const updateProfileSchema = z.object({
  full_name: z.string().trim().min(2).max(80).optional(),
  phone: optionalText(30),
  room: optionalText(20),
  reminders_enabled: z.boolean().optional(),
  onboarded: z.boolean().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
