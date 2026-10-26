import { ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listTemplates } from "@/lib/data/admin";
import { TEMPLATE_DEFAULTS, TEMPLATE_META } from "@/lib/data/template-defaults";

export const dynamic = "force-dynamic";

/** GET /api/admin/templates — every notification kind with its current template, default and metadata. */
export const GET = withHandler(async () => {
  await requireRole("admin");
  const templates = await listTemplates();
  return ok({
    templates: templates.map((t) => ({ ...t, default: TEMPLATE_DEFAULTS[t.key], meta: TEMPLATE_META[t.key] })),
  });
});
