import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { PickupRequestStatus } from "@/components/trips/PickupRequestStatus";
import { TripsAutoRefresh } from "@/components/trips/TripsAutoRefresh";
import { requirePageAuth } from "@/lib/auth/page";
import { getSettings } from "@/lib/data/settings";
import { getMyPickupRequest } from "@/lib/data/student";
import { formatTime } from "@/lib/time";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export default async function PickupRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const { user } = await requirePageAuth();
  const [settings, request] = await Promise.all([getSettings(), getMyPickupRequest(id, user.id)]);
  if (!request) notFound();

  const { pickup_location, trip, ...plain } = request;
  const now = new Date();

  return (
    <Page>
      <AppHeader back="/app" title="Pickup" greeting="Your request" />
      <TripsAutoRefresh userId={user.id} watchRequests />
      <PickupRequestStatus
        key={`${plain.id}:${plain.updated_at}`}
        initial={plain}
        pickupName={pickup_location?.name ?? null}
        tripTime={trip ? formatTime(trip.departure_at, settings.timezone) : null}
        tripId={trip?.id ?? null}
        timeZone={settings.timezone}
        nowMs={now.getTime()}
      />
    </Page>
  );
}
