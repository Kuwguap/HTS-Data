import { z } from "zod";
import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { createClient } from "@/lib/supabase/server";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

// Request shape for marking inbox items read. Lives here until a
// src/lib/validation/notifications.ts schema exists (see report).
const markReadSchema = z.object({ ids: z.array(uuid).min(1).max(200) });

/**
 * POST /api/notifications/read — { ids: [] } → mark those inbox items read.
 * Uses the cookie client so RLS + mark_notifications_read() keep it to own rows.
 */
export const POST = withHandler(async (request) => {
  await requireUser();
  const { ids } = await parseBody(request, markReadSchema);
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_notifications_read", { p_ids: ids });
  if (error) throw new ApiError(500, "INTERNAL", "Could not update your inbox. Try again.");
  return ok({ read: ids.length });
});
