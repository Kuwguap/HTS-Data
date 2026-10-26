import { randomUUID } from "node:crypto";
import { ok, parseBody, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { enqueueNotification } from "@/lib/notify/enqueue";
import { drainOutbox } from "@/lib/push/drain";
import { createAdminClient } from "@/lib/supabase/admin";
import { broadcastSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Only same-origin paths may be opened from a push. */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("//") ? trimmed : null;
}

/**
 * POST /api/admin/broadcast — send an announcement (broadcastSchema) to the
 * chosen audience. Drains inline (bounded) so the response can report counts;
 * anything left over goes out on the next tick.
 */
export const POST = withHandler(async (request) => {
  await requireRole("admin");
  const input = await parseBody(request, broadcastSchema);
  const admin = createAdminClient();
  const settings = await getSettings();

  let query = admin.from("profiles").select("id").eq("is_active", true);
  if (input.audience === "students") query = query.eq("role", "student");
  else if (input.audience === "drivers") query = query.in("role", ["driver", "admin"]);
  const { data: people, error } = await query;
  if (error) console.error("[admin] broadcast audience failed:", error.message);
  const ids = (people ?? []).map((p) => p.id);

  const enqueued = await enqueueNotification(admin, {
    userIds: ids,
    kind: "broadcast",
    vars: { title: input.title, message: input.message, hostel: settings.hostel_name },
    url: safeUrl(input.url) ?? "/app/inbox",
    dedupePrefix: `bcast:${randomUUID()}`,
    ttlSeconds: 6 * 3600,
    urgency: "normal",
  });

  const push = enqueued > 0 ? await drainOutbox({ admin, budgetMs: 40_000 }) : null;

  return ok({
    recipients: ids.length,
    enqueued,
    sent: push?.sent ?? 0,
    skipped: push?.skipped ?? 0,
    failed: push?.failed ?? 0,
    requeued: push?.requeued ?? 0,
    deliveries: push?.deliveries ?? 0,
  });
});
