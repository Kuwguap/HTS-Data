import { ok, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { listNotifications, unreadCount } from "@/lib/data/student";

export const dynamic = "force-dynamic";

/** GET /api/notifications — my latest 50 inbox items + unread count. */
export const GET = withHandler(async () => {
  const { user } = await requireUser();
  const [notifications, unread] = await Promise.all([listNotifications(user.id, { limit: 50 }), unreadCount(user.id)]);
  return ok({ notifications, unread }, { headers: { "Cache-Control": "no-store" } });
});
