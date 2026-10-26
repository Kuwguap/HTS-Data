import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageAuth } from "@/lib/auth/page";
import { getManifest } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import { formatAgo, formatDayTime, formatTime } from "@/lib/time";
import { TRIP_LOCATION_COLUMNS } from "@/lib/tracking/columns";
import { TRIP_STATUS_LABEL, TRIP_STATUS_TONE, directionLabel, isTripActive, isTripLive } from "@/lib/trips";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { Button, Caption, Card, Empty, LiveChip, List, Pill, Row, StatTile } from "@/components/ui";
import { ClaimTripButton } from "@/components/driver/ClaimTripButton";
import { LiveRefresh } from "@/components/driver/LiveRefresh";
import { RequestCard } from "@/components/driver/RequestCard";
import { RiderRow } from "@/components/driver/RiderRow";
import { TripStatusActions } from "@/components/driver/TripStatusActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Riders" };

export default async function DriverManifestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, profile } = await requirePageAuth({ role: "driver" });
  const [settings, manifest] = await Promise.all([getSettings(), getManifest(id)]);
  if (!manifest) notFound();
  const { trip, groups, waitlist, acceptedRequests, counts } = manifest;

  const mine = trip.driver_id === user.id;
  const canAct = mine || trip.driver_id === null || profile.role === "admin";
  const active = isTripActive(trip);
  const live = isTripLive(trip, settings);
  const readOnly = !active || !canAct;

  return (
    <Page>
      <AppHeader
        back="/driver"
        greeting={directionLabel(trip.direction, settings)}
        title={formatTime(trip.departure_at, settings.timezone)}
        right={live ? <LiveChip live label="Live" /> : <Pill tone={TRIP_STATUS_TONE[trip.status]}>{TRIP_STATUS_LABEL[trip.status]}</Pill>}
      />
      <LiveRefresh table="bookings" filter={`trip_id=eq.${trip.id}`} />
      <LiveRefresh table="pickup_requests" />
      {/* GPS fixes rewrite trips.last_* every 15 s; the manifest only cares about status/seat changes. */}
      <LiveRefresh table="trips" filter={`id=eq.${trip.id}`} event="UPDATE" ignoreColumns={TRIP_LOCATION_COLUMNS} />

      <List>
        <Row label="Departure" value={formatDayTime(trip.departure_at, new Date(), settings.timezone)} />
        <Row label="Route" value={`${trip.origin_label} → ${trip.destination_label}`} />
        <Row label="Seats" value={`${trip.confirmed_count}/${trip.seat_capacity}`} />
        <Row
          label="Driver"
          value={mine ? "You" : trip.driver_id ? "Another driver" : "Nobody yet"}
          trailing={trip.driver_id === null && active ? <ClaimTripButton tripId={trip.id} /> : undefined}
        />
        {trip.cancel_reason ? <Row label="Reason" value={trip.cancel_reason} /> : null}
        {trip.last_location_at ? <Row label="Last fix" value={formatAgo(trip.last_location_at)} /> : null}
      </List>

      {active && canAct ? (
        <Card>
          <div className="flex flex-col gap-2">
            <TripStatusActions trip={trip} />
            {trip.status === "boarding" || trip.status === "departed" ? (
              <Button variant="secondary" size="big" href={`/driver/trips/${trip.id}/track`}>
                📍 {live ? "Open tracking" : "Start tracking"}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="k-grid-3">
        <StatTile value={counts.confirmed} label="Confirmed" art="seat" zero={counts.confirmed === 0} />
        <StatTile value={counts.waitlist} label="Waitlist" art="clock" zero={counts.waitlist === 0} />
        <StatTile value={counts.boarded} label="Boarded" art="check" zero={counts.boarded === 0} />
      </div>

      {groups.length === 0 && waitlist.length === 0 ? (
        <Card>
          <Empty art="team" title="No riders yet" hint={active ? "Bookings show up here the moment a student reserves a seat." : "Nobody booked this trip."} />
        </Card>
      ) : null}

      {groups.map((g) => (
        <List key={g.id ?? "none"} caption={`📍 ${g.name} · ${g.riders.length}`} captionAction={g.boarded > 0 ? <span style={{ color: "var(--tone-green-ink)", fontWeight: 700 }}>{g.boarded} on board</span> : undefined}>
          {g.riders.map((b) => (
            <RiderRow key={b.id} tripId={trip.id} booking={b} readOnly={readOnly} />
          ))}
        </List>
      ))}

      {waitlist.length > 0 ? (
        <List caption={`⏳ Waitlist · ${waitlist.length}`}>
          {waitlist.map((b) => (
            <RiderRow key={b.id} tripId={trip.id} booking={b} waitlist readOnly={readOnly} />
          ))}
        </List>
      ) : null}

      {acceptedRequests.length > 0 ? (
        <div className="flex flex-col gap-3">
          <Caption>✋ Accepted pickups · {acceptedRequests.length}</Caption>
          {acceptedRequests.map((r) => (
            <RequestCard key={r.id} request={r} timezone={settings.timezone} />
          ))}
        </div>
      ) : null}
    </Page>
  );
}
