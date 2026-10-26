import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { BroadcastForm } from "@/components/admin/BroadcastForm";
import { listTemplates, listUsers } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";

export const dynamic = "force-dynamic";

export default async function AdminBroadcastPage() {
  const [settings, users, templates] = await Promise.all([getSettings(), listUsers({ role: "all", limit: 5000 }), listTemplates()]);
  const active = users.filter((u) => u.is_active);
  const counts = {
    students: active.filter((u) => u.role === "student").length,
    drivers: active.filter((u) => u.role !== "student").length,
    all: active.length,
  };
  const template = templates.find((t) => t.key === "broadcast") ?? { title: "📣 {title}", body: "{message}" };
  return (
    <Page>
      <AppHeader title="Announcement" back="/admin/more" greeting="Push a message to everyone's phone" />
      <BroadcastForm counts={counts} template={{ title: template.title, body: template.body }} hostelName={settings.hostel_name} />
    </Page>
  );
}
