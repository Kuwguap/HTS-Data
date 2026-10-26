import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { ScheduleEditor } from "@/components/admin/ScheduleEditor";
import { listSchedule } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";

export const dynamic = "force-dynamic";

export default async function AdminSchedulePage() {
  const [settings, schedule] = await Promise.all([getSettings(), listSchedule()]);
  return (
    <Page>
      <AppHeader title="Schedule" greeting={`${schedule.filter((s) => s.is_active).length} active departures`} />
      <ScheduleEditor schedule={schedule} defaultCapacity={settings.default_seat_capacity} campusName={settings.campus_name} hostelName={settings.hostel_name} />
    </Page>
  );
}
