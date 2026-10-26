import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { TripAdmin } from "@/components/admin/TripAdmin";
import { getTripAdmin, listDrivers } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { formatTime } from "@/lib/time";
import { directionShort } from "@/lib/trips";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export default async function AdminTripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const [settings, data, drivers] = await Promise.all([getSettings(), getTripAdmin(id), listDrivers()]);
  if (!data) notFound();
  const { trip, bookings } = data;
  return (
    <Page>
      <AppHeader title={formatTime(trip.departure_at, settings.timezone)} greeting={`${directionShort(trip.direction)} · ${trip.service_date}`} back={`/admin/trips?date=${trip.service_date}`} />
      <TripAdmin trip={trip} bookings={bookings} drivers={drivers} timeZone={settings.timezone} />
    </Page>
  );
}
