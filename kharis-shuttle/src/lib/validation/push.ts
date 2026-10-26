import { z } from "zod";

export const pushSubscribeSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(10).max(512),
    auth: z.string().min(5).max(256),
  }),
  expirationTime: z.number().nullable().optional(),
  user_agent: z.string().max(512).optional().nullable(),
  platform: z.enum(["ios", "android", "desktop", "other"]).optional().nullable(),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({
  endpoint: z.url().max(2048),
});
