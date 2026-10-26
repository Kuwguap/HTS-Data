import type { Metadata } from "next";
import { requirePageAuth } from "@/lib/auth/page";
import { driverDateRange, listTripsForDriver } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import { formatAgo } from "@/lib/time";
import { TRIP_STATUS_LABEL, isTripLive, tripTitle } from "@/lib/trips";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { Button, Card, Empty, LiveChip, List, Row } from "@/components/ui";
import { LiveRefresh } from "@/components/driver/LiveRefresh";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Live" };

/** Today's trips that are boarding or on the way, with a link to track (mine) or watch. */
export default async function DriverLivePage() {
  const { user } = await requirePageAuth({ role: "driver" });
  const [settings, trips, range] = await Promise.all([getSettings(), listTripsForDriver(user.id), driverDateRange()]);
  const running = trips.filter((t) => t.service_date === range.today && (t.status === "boarding" || t.status === "departed"));
  const anyLive = running.some((t) => isTripLive(t, settings));

  return (
    <Page>
      <AppHeader title="Live" greeting="Buses on the road" right={<LiveChip live={anyLive} />} />
      <LiveRefresh table="trips" />

      {running.length === 0 ? (
        <Card>
          <Empty art="track" title="Nothing on the road" hint="Start boarding a trip and share your location — it shows up here and on every rider’s map." action={<Button pill variant="secondary" href="/driver">🚌 Trips</Button>} />
        </Card>
      ) : (
        <List caption="Running now">
          {running.map((t) => {
            const live = isTripLive(t, settings);
            const own = t.isMine || t.unassigned;
            return (
              <Row
                key={t.id}
                href={own ? `/driver/trips/${t.id}/track` : `/app/trips/${t.id}/map`}
                title={tripTitle(t, settings.timezone)}
                subtitle={`${TRIP_STATUS_LABEL[t.status]} · ${t.confirmed_count} riders · ${t.last_location_at ? `last fix ${formatAgo(t.last_location_at)}` : "no position yet"}${own ? "" : " · another driver"}`}
                trailing={<LiveChip live={live} label={live ? "Live" : "Off"} />}
              />
            );
          })}
        </List>
      )}

      {running.length > 0 ? (
        <p style={{ margin: "0 4px", color: "var(--hint)", fontSize: "var(--fs-sm)" }}>
          Tap your trip to open tracking, or another driver’s trip to watch it on the map.
        </p>
      ) : null}
    </Page>
  );
}
