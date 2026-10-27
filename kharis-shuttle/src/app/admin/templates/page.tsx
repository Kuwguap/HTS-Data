import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { TemplatesEditor } from "@/components/admin/TemplatesEditor";
import { listTemplates } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { requirePageAuth } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function AdminTemplatesPage() {
  await requirePageAuth({ role: "admin" });
  const [settings, templates] = await Promise.all([getSettings(), listTemplates()]);
  return (
    <Page>
      <AppHeader title="Messages" back="/admin/more" greeting={`${templates.filter((t) => !t.is_default).length} of ${templates.length} customised`} />
      <TemplatesEditor templates={templates} hostelName={settings.hostel_name} campusName={settings.campus_name} />
    </Page>
  );
}
