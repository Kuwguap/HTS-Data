import { ApiError, ok, parseBody, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { createClient } from "@/lib/supabase/server";
import { markNotificationsReadSchema } from "@/lib/validation/notifications";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/read — { ids: [] } → mark those inbox items read.
 * Uses the cookie client so RLS + mark_notifications_read() keep it to own rows.
 */
export const POST = withHandler(async (request) => {
  await requireUser();
  const { ids } = await parseBody(request, markNotificationsReadSchema);
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_notifications_read", { p_ids: ids });
  if (error) throw new ApiError(500, "INTERNAL", "Could not update your inbox. Try again.");
  return ok({ read: ids.length });
});
