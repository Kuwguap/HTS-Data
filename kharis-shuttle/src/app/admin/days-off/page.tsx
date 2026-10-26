import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { DaysOffEditor } from "@/components/admin/DaysOffEditor";
import { listDaysOff } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { localDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AdminDaysOffPage() {
  const [settings, daysOff] = await Promise.all([getSettings(), listDaysOff()]);
  const today = localDateString(new Date(), settings.timezone);
  return (
    <Page>
      <AppHeader title="Days off" back="/admin/more" greeting="Holidays and no-service days" />
      <DaysOffEditor daysOff={daysOff} today={today} timeZone={settings.timezone} />
    </Page>
  );
}
