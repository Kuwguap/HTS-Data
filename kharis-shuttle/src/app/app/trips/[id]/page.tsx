import { notFound } from "next/navigation";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { BookSheet } from "@/components/trips/BookSheet";
import { CancelBookingButton } from "@/components/trips/CancelBookingButton";
import { TripsAutoRefresh } from "@/components/trips/TripsAutoRefresh";
import { Banner, Button, Card, HeroCard, HeroPill, List, LiveChip, Pill, Row, type GradTone } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import { getTripForStudent } from "@/lib/data/student";
import type { TripStatus } from "@/lib/db.types";
import { formatCountdown, formatDayTime, formatFare, formatTime } from "@/lib/time";
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  TRIP_STATUS_LABEL,
  TRIP_STATUS_TONE,
  directionLabel,
  fareLine,
  isActiveBooking,
  isBookingOpen,
  isTripLive,
  seatsLeft,
} from "@/lib/trips";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

const HERO_TONE: Record<TripStatus, GradTone> = {
  scheduled: "blue",
  boarding: "orange",
  departed: "green",
  arrived: "slate",
  cancelled: "red",
  expired: "slate",
};

export default async function TripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const { user } = await requirePageAuth();
  const [settings, pickupLocations, trip] = await Promise.all([getSettings(), getActivePickupLocations(), getTripForStudent(id, user.id)]);
  if (!trip) notFound();

  const now = new Date();
  const tz = settings.timezone;
  const mine = isActiveBooking(trip.my_booking) ? trip.my_booking : null;
  const open = isBookingOpen(trip, settings, now);
  const live = isTripLive(trip, settings, now);
  const moving = trip.status === "boarding" || trip.status === "departed";
  const left = seatsLeft(trip);
  const time = formatTime(trip.departure_at, tz);

  let heroCta: string;
  if (live) heroCta = "📍 Bus is sharing its location";
  else if (moving) heroCta = "🚌 The bus isn't sharing its location yet";
  else if (trip.status === "scheduled") heroCta = `⏱ Leaves ${formatCountdown(trip.departure_at, now)}`;
  else heroCta = TRIP_STATUS_LABEL[trip.status];

  return (
    <Page>
      <AppHeader back="/app" title={time} greeting={formatDayTime(trip.departure_at, now, tz)} right={moving ? <LiveChip live={live} /> : undefined} />
      <TripsAutoRefresh userId={user.id} tripId={trip.id} />

      <HeroCard
        tone={HERO_TONE[trip.status]}
        title={directionLabel(trip.direction, settings)}
        subtitle={`${TRIP_STATUS_LABEL[trip.status]} · ${left} of ${trip.seat_capacity} seats left`}
        art="bus"
        cta={<HeroPill>{heroCta}</HeroPill>}
        href={moving ? `/app/trips/${trip.id}/map` : undefined}
      />

      {trip.status === "cancelled" ? (
        <Banner tone="red" icon="⚠️">
          This shuttle was cancelled{trip.cancel_reason ? ` — ${trip.cancel_reason}` : "."}
        </Banner>
      ) : null}

      <List caption="Trip">
        <Row label="Departure" value={formatDayTime(trip.departure_at, now, tz)} />
        <Row label="Route" value={`${trip.origin_label} → ${trip.destination_label}`} />
        <Row
          label="Seats"
          value={`${left} of ${trip.seat_capacity} left${trip.waitlist_count > 0 ? ` · ${trip.waitlist_count} waiting` : ""}`}
        />
        <Row label="Fare" value={fareLine(settings)} />
        <Row
          label="Status"
          value={
            <Pill tone={TRIP_STATUS_TONE[trip.status]} sm>
              {TRIP_STATUS_LABEL[trip.status]}
            </Pill>
          }
        />
      </List>

      {mine ? (
        <Card
          title="My seat"
          action={
            <Pill tone={BOOKING_STATUS_TONE[mine.status]}>
              {BOOKING_STATUS_LABEL[mine.status]}
              {mine.status === "waitlisted" && mine.waitlist_position ? ` #${mine.waitlist_position}` : ""}
            </Pill>
          }
        >
          <List>
            <Row label="Pickup" value={mine.pickup_location?.name ?? "Not set"} />
            {mine.pickup_note ? <Row label="Note" value={mine.pickup_note} /> : null}
            <Row label="Pay" value={`${formatFare(settings.fare_pesewas, settings.currency)} cash to the driver`} />
          </List>
          {mine.status === "waitlisted" ? (
            <p style={{ margin: "10px 0 0", color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
              {"You'll get a push the moment a seat opens up."}
            </p>
          ) : null}
        </Card>
      ) : trip.my_booking && trip.my_booking.status !== "cancelled" ? (
        <Card title="My seat" action={<Pill tone={BOOKING_STATUS_TONE[trip.my_booking.status]}>{BOOKING_STATUS_LABEL[trip.my_booking.status]}</Pill>} />
      ) : null}

      <div className="flex flex-col gap-2">
        {moving ? (
          <Button size="big" href={`/app/trips/${trip.id}/map`}>
            📍 Track the bus
          </Button>
        ) : null}
        {!mine && open ? (
          <BookSheet
            trip={trip}
            pickupLocations={pickupLocations}
            fare={formatFare(settings.fare_pesewas, settings.currency)}
            timeZone={tz}
            size="big"
            nowMs={now.getTime()}
          />
        ) : null}
        {mine && open ? <CancelBookingButton bookingId={mine.id} tripLabel={time} waitlisted={mine.status === "waitlisted"} size="md" /> : null}
        {!open && !moving && trip.status === "scheduled" ? (
          <Banner tone="amber" icon="⏰">
            Booking closes {settings.booking_cutoff_minutes} min before departure.
          </Banner>
        ) : null}
        {trip.status === "scheduled" || moving ? (
          <Button variant="secondary" href={`/app/request?trip=${trip.id}`}>
            ✋ Request a pickup
          </Button>
        ) : null}
      </div>
    </Page>
  );
}
