import type { Metadata } from "next";
import { requirePageAuth } from "@/lib/auth/page";
import { driverDateRange, listTripsForDriver, pendingRequestCount, type DriverTrip } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import { formatTime } from "@/lib/time";
import { TRIP_STATUS_LABEL, TRIP_STATUS_TONE, directionShort, isTripActive, isTripLive, nextTrip, tripTitle } from "@/lib/trips";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { ReminderBanner } from "@/components/pwa/ReminderBanner";
import { Button, Caption, Card, Empty, LiveChip, List, Pill, Row, StatTile } from "@/components/ui";
import { ClaimTripButton } from "@/components/driver/ClaimTripButton";
import { LiveRefresh } from "@/components/driver/LiveRefresh";
import { TripStatusActions } from "@/components/driver/TripStatusActions";
import { HeroCard } from "@/components/ui/HeroCard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Trips" };

function greeting(name: string, hour: number): string {
  const first = name.split(/\s+/)[0] ?? name;
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return `${part}, ${first}`;
}

export default async function DriverHomePage() {
  const { user, profile } = await requirePageAuth({ role: "driver" });
  const [settings, trips, pending, range] = await Promise.all([getSettings(), listTripsForDriver(user.id), pendingRequestCount(), driverDateRange()]);
  const now = new Date();

  const today = trips.filter((t) => t.service_date === range.today);
  const tomorrow = trips.filter((t) => t.service_date !== range.today);
  const liveMine = trips.find((t) => t.isMine && isTripLive(t, settings, now)) ?? null;
  const runningMine = trips.find((t) => t.isMine && (t.status === "boarding" || t.status === "departed")) ?? null;
  const current: DriverTrip | null = runningMine ?? nextTrip(today, now) ?? nextTrip(trips, now);
  const unassigned = trips.filter((t) => t.unassigned && isTripActive(t));

  const ridersToday = today.reduce((n, t) => n + (t.status === "cancelled" || t.status === "expired" ? 0 : t.confirmed_count), 0);
  const tripsLeft = today.filter((t) => isTripActive(t)).length;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "numeric", hour12: false }).format(now));

  const tripRow = (t: DriverTrip) => (
    <Row
      key={t.id}
      href={`/driver/trips/${t.id}`}
      title={tripTitle(t, settings.timezone)}
      subtitle={`${t.confirmed_count} riders · ${t.waitlist_count} waiting${t.boarded_count ? ` · ${t.boarded_count} on board` : ""}${t.unassigned ? " · needs a driver" : t.isMine ? "" : " · another driver"}`}
      trailing={
        <Pill tone={t.unassigned && isTripActive(t) ? "amber" : TRIP_STATUS_TONE[t.status]} sm>
          {TRIP_STATUS_LABEL[t.status]}
        </Pill>
      }
    />
  );

  return (
    <Page>
      <AppHeader greeting={greeting(profile.full_name, hour)} title="Trips" right={liveMine ? <LiveChip live label="Live" /> : null} />
      <LiveRefresh table="trips" />
      <LiveRefresh table="pickup_requests" />
      <ReminderBanner />

      {current ? (
        <HeroCard
          tone="green"
          title={`${formatTime(current.departure_at, settings.timezone)} · ${directionShort(current.direction)}`}
          subtitle={`${current.confirmed_count} riders · ${current.waitlist_count} waiting · ${current.origin_label} → ${current.destination_label}`}
          art="bus"
          disc="steering"
          cta={
            current.isMine || current.unassigned ? (
              <div className="flex flex-wrap gap-2">
                <TripStatusActions trip={current} variant="hero" />
                <Button pill variant="secondary" href={`/driver/trips/${current.id}`} style={{ background: "rgba(255,255,255,0.22)", color: "#fff" }}>
                  📋 Riders
                </Button>
              </div>
            ) : (
              <Button pill variant="secondary" href={`/driver/trips/${current.id}`} style={{ background: "rgba(255,255,255,0.22)", color: "#fff" }}>
                📋 Riders
              </Button>
            )
          }
        />
      ) : (
        <Card>
          <Empty art="bus" title="No trips coming up" hint="The next scheduled departure will show here. You can still announce a return trip." />
        </Card>
      )}

      <div className="k-grid-2">
        <StatTile value={ridersToday} label="Riders today" art="team" zero={ridersToday === 0} />
        <StatTile value={pending} label="Pending requests" art="hand" danger={pending > 0} zero={pending === 0} href="/driver/requests" />
        <StatTile value={tripsLeft} label="Trips left today" art="calendar" zero={tripsLeft === 0} />
        <StatTile
          value={liveMine ? "LIVE" : "Off"}
          label="Tracking"
          art="track"
          zero={!liveMine}
          href={liveMine ? `/driver/trips/${liveMine.id}/track` : runningMine ? `/driver/trips/${runningMine.id}/track` : "/driver/live"}
        />
      </div>

      {today.length > 0 ? (
        <List caption="Today">{today.map(tripRow)}</List>
      ) : (
        <div>
          <Caption>Today</Caption>
          <Card>
            <Empty art="calendar" title="No shuttles today" hint="Days off and the timetable are set by the office." />
          </Card>
        </div>
      )}

      {tomorrow.length > 0 ? <List caption="Tomorrow">{tomorrow.map(tripRow)}</List> : null}

      {unassigned.length > 0 ? (
        <List caption="Needs a driver">
          {unassigned.map((t) => (
            <Row key={t.id} title={tripTitle(t, settings.timezone)} subtitle={`${t.confirmed_count} riders · ${t.service_date === range.today ? "today" : "tomorrow"}`} trailing={<ClaimTripButton tripId={t.id} />} chevron={false} />
          ))}
        </List>
      ) : null}

      <div>
        <Caption>Return trip</Caption>
        <Button size="big" href="/driver/announce">
          📣 Announce a return trip
        </Button>
        <p style={{ margin: "8px 4px 0", color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
          “Shuttle is at {settings.campus_name} heading to the hostel” — one tap tells every student and starts tracking.
        </p>
      </div>
    </Page>
  );
}
