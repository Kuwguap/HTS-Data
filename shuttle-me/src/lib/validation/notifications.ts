import { z } from "zod";
import { uuid } from "./common";

export const markNotificationsReadSchema = z.object({
  ids: z.array(uuid).min(1).max(200),
});
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;
