import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import LiveTripMap from "@/components/map/LiveTripMapLoader";
import { Button, Card, LiveChip, Pill } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import { getTripForStudent } from "@/lib/data/student";
import { formatAgo, formatTime } from "@/lib/time";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE, TRIP_STATUS_LABEL, directionShort, isActiveBooking, isTripLive } from "@/lib/trips";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export default async function TripMapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const { user } = await requirePageAuth();
  const [settings, pickupLocations, trip] = await Promise.all([getSettings(), getActivePickupLocations(), getTripForStudent(id, user.id)]);
  if (!trip) notFound();

  const now = new Date();
  const live = isTripLive(trip, settings, now);
  const mine = isActiveBooking(trip.my_booking) ? trip.my_booking : null;
  const { my_booking: _mine, ...plainTrip } = trip;

  return (
    <main className="k-shell">
      <div className="k-page" style={{ gap: 12 }}>
        <AppHeader
          back={`/app/trips/${trip.id}`}
          title="Live"
          greeting={`${formatTime(trip.departure_at, settings.timezone)} · ${directionShort(trip.direction)}`}
          right={<LiveChip live={live} label={live ? "Live" : trip.status === "boarding" || trip.status === "departed" ? "Waiting" : "Off"} />}
        />
        {/* No TripsAutoRefresh here: the map's useTripLocation already follows the trip row and GPS broadcasts. */}
        <div
          className="k-card"
          style={{
            padding: 0,
            overflow: "hidden",
            height: "calc(100dvh - 220px - var(--tabbar-h) - var(--safe-bottom))",
            minHeight: 320,
          }}
        >
          <LiveTripMap
            tripId={trip.id}
            initialTrip={plainTrip}
            pickupLocations={pickupLocations}
            myPickupLocationId={mine?.pickup_location_id ?? null}
            myBookingStatus={mine?.status ?? null}
            settings={{
              timezone: settings.timezone,
              location_stale_seconds: settings.location_stale_seconds,
              hostel_name: settings.hostel_name,
              campus_name: settings.campus_name,
            }}
          />
        </div>

        <Card>
          <div className="flex items-center justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>
                {live ? "Bus is moving" : trip.status === "boarding" || trip.status === "departed" ? "Bus isn't sharing its location yet" : TRIP_STATUS_LABEL[trip.status]}
              </div>
              <div style={{ color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
                {trip.last_location_at ? `Last seen ${formatAgo(trip.last_location_at, now)}` : "No position yet"}
                {mine?.pickup_location ? ` · your pickup: ${mine.pickup_location.name}` : ""}
              </div>
            </div>
            {mine ? (
              <Pill tone={BOOKING_STATUS_TONE[mine.status]} sm>
                {BOOKING_STATUS_LABEL[mine.status]}
              </Pill>
            ) : null}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" href={`/app/request?trip=${trip.id}&direction=${trip.direction}`}>
              ✋ Request pickup here
            </Button>
          </div>
        </Card>
      </div>
    </main>
  );
}
