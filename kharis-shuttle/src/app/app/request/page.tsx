import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { PickupRequestForm } from "@/components/trips/PickupRequestForm";
import { Banner } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import { getPendingPickupRequest, listOpenTripsToday } from "@/lib/data/student";
import type { TripDirection } from "@/lib/db.types";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export default async function RequestPickupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePageAuth();
  const sp = await searchParams;
  const tripParam = typeof sp.trip === "string" && uuid.safeParse(sp.trip).success ? sp.trip : null;
  const dirParam = sp.direction === "to_campus" || sp.direction === "to_hostel" ? (sp.direction as TripDirection) : undefined;

  const pending = await getPendingPickupRequest(user.id);
  if (pending) redirect(`/app/requests/${pending.id}`);

  const [settings, pickupLocations, trips] = await Promise.all([getSettings(), getActivePickupLocations(), listOpenTripsToday()]);

  return (
    <Page>
      <AppHeader back="/app" title="Request a pickup" greeting="Tell the driver where you are" />
      <Banner tone="blue" icon="✋">
        The driver sees your request on their phone and can accept or decline. Fare stays {settings.payment_note.toLowerCase().includes("cash") ? "cash only" : "the same"}.
      </Banner>
      <PickupRequestForm
        pickupLocations={pickupLocations}
        trips={trips.map((t) => ({ id: t.id, departure_at: t.departure_at, direction: t.direction, status: t.status }))}
        defaultTripId={tripParam}
        defaultDirection={dirParam}
        timeZone={settings.timezone}
      />
    </Page>
  );
}
