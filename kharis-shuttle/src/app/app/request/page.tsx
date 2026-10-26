import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { PickupRequestForm } from "@/components/trips/PickupRequestForm";
import { Banner } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import { getPendingPickupRequest, getTripForStudent, listOpenTripsToday } from "@/lib/data/student";
import type { Trip, TripDirection } from "@/lib/db.types";
import { addDays, formatDayLabel, localDateString } from "@/lib/time";
import { isTripActive } from "@/lib/trips";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/** A ?trip= prefill is usable when it is still running and leaves today or tomorrow (hostel time). */
function isRequestableTrip(trip: Pick<Trip, "status" | "service_date">, now: Date, timeZone: string): boolean {
  if (!isTripActive(trip)) return false;
  return trip.service_date === localDateString(now, timeZone) || trip.service_date === localDateString(addDays(now, 1), timeZone);
}

export default async function RequestPickupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePageAuth();
  const sp = await searchParams;
  const tripParam = typeof sp.trip === "string" && uuid.safeParse(sp.trip).success ? sp.trip : null;
  const dirParam = sp.direction === "to_campus" || sp.direction === "to_hostel" ? (sp.direction as TripDirection) : undefined;

  const pending = await getPendingPickupRequest(user.id);
  if (pending) redirect(`/app/requests/${pending.id}`);

  const [settings, pickupLocations, openToday, prefill] = await Promise.all([
    getSettings(),
    getActivePickupLocations(),
    listOpenTripsToday(),
    tripParam ? getTripForStudent(tripParam, user.id) : Promise.resolve(null),
  ]);

  // The prefilled trip may be tomorrow's (or just outside the "open today" window): include it when it is still active.
  const now = new Date();
  const prefillTrip = prefill && isRequestableTrip(prefill, now, settings.timezone) ? prefill : null;
  const trips: Trip[] = [...openToday];
  if (prefillTrip && !trips.some((t) => t.id === prefillTrip.id)) {
    trips.push(prefillTrip);
    trips.sort((a, b) => new Date(a.departure_at).getTime() - new Date(b.departure_at).getTime());
  }
  const today = localDateString(now, settings.timezone);

  return (
    <Page>
      <AppHeader back="/app" title="Request a pickup" greeting="Tell the driver where you are" />
      <Banner tone="blue" icon="✋">
        The driver sees your request on their phone and can accept or decline. Fare stays {settings.payment_note.toLowerCase().includes("cash") ? "cash only" : "the same"}.
      </Banner>
      <PickupRequestForm
        pickupLocations={pickupLocations}
        trips={trips.map((t) => ({
          id: t.id,
          departure_at: t.departure_at,
          direction: t.direction,
          status: t.status,
          day: t.service_date === today ? undefined : formatDayLabel(t.departure_at, now, settings.timezone),
        }))}
        defaultTripId={prefillTrip?.id ?? null}
        defaultDirection={prefillTrip?.direction ?? dirParam}
        timeZone={settings.timezone}
      />
    </Page>
  );
}
