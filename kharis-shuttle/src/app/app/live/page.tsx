import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { TripsAutoRefresh } from "@/components/trips/TripsAutoRefresh";
import { Art, Button, Card, Empty, HeroCard, HeroPill, List, LiveChip, Row } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getSettings } from "@/lib/data/settings";
import { listTripsForStudent, liveTrips } from "@/lib/data/student";
import { formatAgo, formatCountdown, formatDayTime, formatTime } from "@/lib/time";
import { TRIP_STATUS_LABEL, directionShort, isTripLive, nextTrip, seatsLeft } from "@/lib/trips";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const { user } = await requirePageAuth();
  const [settings, moving, trips] = await Promise.all([getSettings(), liveTrips(), listTripsForStudent(user.id)]);
  const now = new Date();
  const tz = settings.timezone;
  const anyLive = moving.some((t) => isTripLive(t, settings, now));
  const next = nextTrip(trips, now);

  return (
    <Page>
      <AppHeader title="Live" right={<LiveChip live={anyLive} label={anyLive ? "Live" : "Off"} />} />
      <TripsAutoRefresh userId={user.id} />

      {moving.length > 0 ? (
        <List caption="On the road now">
          {moving.map((t) => {
            const live = isTripLive(t, settings, now);
            return (
              <Row
                key={t.id}
                href={`/app/trips/${t.id}/map`}
                leading={<Art k="bus" size={32} />}
                title={`${formatTime(t.departure_at, tz)} · ${directionShort(t.direction)}`}
                subtitle={
                  live
                    ? `Moving · last seen ${formatAgo(t.last_location_at, now)}`
                    : `${TRIP_STATUS_LABEL[t.status]} · not sharing its location yet`
                }
                trailing={<LiveChip live={live} label={live ? "Live" : "Waiting"} />}
              />
            );
          })}
        </List>
      ) : next ? (
        <>
          <HeroCard
            tone="slate"
            title={`Next shuttle ${formatTime(next.departure_at, tz)}`}
            subtitle={`${formatDayTime(next.departure_at, now, tz)} · ${seatsLeft(next)} seats left`}
            art="track"
            cta={<HeroPill>⏱ Leaves {formatCountdown(next.departure_at, now)}</HeroPill>}
            href={`/app/trips/${next.id}`}
          />
          <Card>
            <Empty
              art="track"
              title="The bus isn't sharing its location yet"
              hint="Tracking starts when the driver begins boarding. This tab updates by itself."
              action={
                <Button pill variant="secondary" href={`/app/trips/${next.id}`}>
                  View departure
                </Button>
              }
            />
          </Card>
        </>
      ) : (
        <Card>
          <Empty art="track" title="No shuttle on the road" hint="Nothing is scheduled right now. Check Today for the next departure." />
        </Card>
      )}
    </Page>
  );
}
