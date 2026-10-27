import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { LocationsEditor, type Destination } from "@/components/admin/LocationsEditor";
import { listLocations } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { requirePageAuth } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  await requirePageAuth({ role: "admin" });
  const [settings, locations] = await Promise.all([getSettings(), listLocations()]);
  // The hostel / campus flags (Settings → Tracking) give the picker map its bearings.
  const destinations: Destination[] = [];
  if (settings.hostel_lat != null && settings.hostel_lng != null) destinations.push({ name: settings.hostel_name, lat: settings.hostel_lat, lng: settings.hostel_lng });
  if (settings.campus_lat != null && settings.campus_lng != null) destinations.push({ name: settings.campus_name, lat: settings.campus_lat, lng: settings.campus_lng });
  return (
    <Page>
      <AppHeader title="Places" greeting={`${locations.filter((l) => l.is_active).length} pickup points shown to students`} />
      <LocationsEditor locations={locations} campusName={settings.campus_name} hostelName={settings.hostel_name} destinations={destinations} />
    </Page>
  );
}
