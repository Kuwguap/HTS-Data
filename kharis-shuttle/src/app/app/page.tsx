import Link from "next/link";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { TripRow } from "@/components/trips/TripRow";
import { TripsAutoRefresh } from "@/components/trips/TripsAutoRefresh";
import { Button, Caption, Card, Empty, HeroCard, HeroPill, List, LiveChip, StatTile } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import { listTripsForStudent, type StudentTrip } from "@/lib/data/student";
import { formatCountdown, formatDayLabel, formatDayTime, formatFare, formatTime, localDateString } from "@/lib/time";
import { BOOKING_STATUS_LABEL, fareLine, isActiveBooking, isBookingOpen, isTripLive, nextTrip, seatsLeft } from "@/lib/trips";

export const dynamic = "force-dynamic";

function greetingFor(now: Date, timeZone: string, name: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hour12: false }).format(now)) % 24;
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return `${part}, ${name} 👋`;
}

export default async function TodayPage() {
  const { user, profile } = await requirePageAuth();
  const [settings, pickupLocations, trips] = await Promise.all([
    getSettings(),
    getActivePickupLocations(),
    listTripsForStudent(user.id),
  ]);

  const now = new Date();
  const nowMs = now.getTime();
  const tz = settings.timezone;
  const today = localDateString(now, tz);
  const firstName = profile.full_name.trim().split(/\s+/)[0] ?? profile.full_name;

  const anyLive = trips.some((t) => isTripLive(t, settings, now));
  const next = nextTrip(trips, now);
  const nextBooking = next && isActiveBooking(next.my_booking) ? next.my_booking : null;
  const nextLive = next ? isTripLive(next, settings, now) : false;
  const nextOpen = next ? isBookingOpen(next, settings, now) : false;
  const liveTrip = trips.find((t) => isTripLive(t, settings, now)) ?? null;

  // Group by local service date: today first, then tomorrow, etc.
  const groups = new Map<string, StudentTrip[]>();
  for (const t of trips) {
    const list = groups.get(t.service_date) ?? [];
    list.push(t);
    groups.set(t.service_date, list);
  }
  const todayTrips = groups.get(today) ?? [];
  const laterDates = [...groups.keys()].filter((d) => d !== today).sort();

  const rowSettings = {
    timezone: settings.timezone,
    fare_pesewas: settings.fare_pesewas,
    currency: settings.currency,
    booking_cutoff_minutes: settings.booking_cutoff_minutes,
    location_stale_seconds: settings.location_stale_seconds,
  };

  let heroCta = "";
  let heroHref = next ? `/app/trips/${next.id}` : undefined;
  if (next) {
    if (nextLive) {
      heroCta = "📍 Tap to track the bus";
      heroHref = `/app/trips/${next.id}/map`;
    } else if (nextBooking) {
      heroCta = nextBooking.status === "waitlisted" ? `⏳ Waitlist #${nextBooking.waitlist_position ?? "?"}` : "✅ Your seat is reserved";
    } else if (nextOpen) {
      heroCta = seatsLeft(next) > 0 ? "🎟️ Tap to book a seat" : "⏳ Full · tap to join the waitlist";
    } else {
      heroCta = `⏱ Leaves ${formatCountdown(next.departure_at, now)}`;
    }
  }

  return (
    <Page>
      <AppHeader
        greeting={greetingFor(now, tz, firstName)}
        title="Today"
        right={anyLive ? <LiveChip live label="Bus live" /> : undefined}
      />
      <TripsAutoRefresh userId={user.id} />

      {next ? (
        <HeroCard
          tone={nextLive ? "green" : "blue"}
          title={next.service_date === today ? `Next shuttle ${formatTime(next.departure_at, tz)}` : `Next shuttle ${formatDayTime(next.departure_at, now, tz)}`}
          subtitle={`${seatsLeft(next)} seats left · ${fareLine(settings)} · to ${next.destination_label}`}
          art="bus"
          cta={heroCta ? <HeroPill>{heroCta}</HeroPill> : undefined}
          href={heroHref}
        />
      ) : (
        <Card>
          <Empty
            art="calendar"
            title="No shuttle today"
            hint={`Nothing is scheduled right now. Reminders from ${settings.hostel_name} will tell you when the next one is on.`}
            action={
              <Button pill variant="secondary" href="/app/request">
                ✋ Request a pickup
              </Button>
            }
          />
        </Card>
      )}

      <div className="k-grid-2">
        <StatTile
          value={
            next && nextBooking
              ? nextBooking.status === "waitlisted"
                ? `#${nextBooking.waitlist_position ?? "–"}`
                : formatTime(next.departure_at, tz)
              : "—"
          }
          label={nextBooking ? `My seat · ${BOOKING_STATUS_LABEL[nextBooking.status].toLowerCase()}` : "My seat · not booked"}
          zero={!nextBooking}
          art="seat"
          href={next ? `/app/trips/${next.id}` : undefined}
        />
        <StatTile
          value={next ? seatsLeft(next) : "—"}
          label={next ? `Seats left · ${formatTime(next.departure_at, tz)}` : "Seats left"}
          danger={next ? seatsLeft(next) === 0 : false}
          zero={!next}
          art="ticket"
        />
        <StatTile value={formatFare(settings.fare_pesewas, settings.currency)} label="Fare · cash only" art="cash" />
        <StatTile
          value={anyLive ? "LIVE" : "Off"}
          label={anyLive ? "Bus is moving" : "Bus not sharing yet"}
          zero={!anyLive}
          art="track"
          href={liveTrip ? `/app/trips/${liveTrip.id}/map` : "/app/live"}
        />
      </div>

      <List
        caption="Today"
        captionAction={
          <Link href="/app/history" className="k-link" style={{ fontSize: 13, minHeight: 0 }}>
            History ›
          </Link>
        }
      >
        {todayTrips.length === 0 ? (
          <Empty art="bus" title="No departures today" hint="Check tomorrow below, or request a pickup." />
        ) : (
          todayTrips.map((t) => <TripRow key={t.id} trip={t} settings={rowSettings} pickupLocations={pickupLocations} nowMs={nowMs} />)
        )}
      </List>

      {laterDates.map((date) => {
        const list = groups.get(date) ?? [];
        const label = formatDayLabel(list[0]?.departure_at ?? date, now, tz);
        return (
          <List key={date} caption={label}>
            {list.map((t) => (
              <TripRow key={t.id} trip={t} settings={rowSettings} pickupLocations={pickupLocations} nowMs={nowMs} />
            ))}
          </List>
        );
      })}

      <Caption>Need the bus somewhere else?</Caption>
      <Button variant="secondary" href="/app/request">
        ✋ Request a pickup
      </Button>
    </Page>
  );
}
