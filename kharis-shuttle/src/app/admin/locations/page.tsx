import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { LocationsEditor } from "@/components/admin/LocationsEditor";
import { listLocations } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { requirePageAuth } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  await requirePageAuth({ role: "admin" });
  const [settings, locations] = await Promise.all([getSettings(), listLocations()]);
  return (
    <Page>
      <AppHeader title="Places" greeting={`${locations.filter((l) => l.is_active).length} pickup points shown to students`} />
      <LocationsEditor locations={locations} campusName={settings.campus_name} hostelName={settings.hostel_name} />
    </Page>
  );
}
