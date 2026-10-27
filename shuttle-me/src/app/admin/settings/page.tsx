import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { listDrivers, listLocations } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { formatAgo } from "@/lib/time";
import { requirePageAuth } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  await requirePageAuth({ role: "admin" });
  const [settings, drivers, locations] = await Promise.all([getSettings(), listDrivers(), listLocations()]);
  const updated = new Date(settings.updated_at).getTime() > 0 ? `Last saved ${formatAgo(settings.updated_at)}` : "Defaults";
  return (
    <Page>
      <AppHeader title="Settings" back="/admin/more" greeting={updated} />
      <SettingsForm settings={settings} drivers={drivers} locations={locations} />
    </Page>
  );
}
