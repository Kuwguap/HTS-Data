import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { Art, Button, Card, Empty, List, Pill, Row, StatTile } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getSettings } from "@/lib/data/settings";
import { listMyBookings, type BookingWithTrip } from "@/lib/data/student";
import { formatFare, formatShortDate, formatTime } from "@/lib/time";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE, directionShort } from "@/lib/trips";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const { user } = await requirePageAuth();
  const [settings, bookings] = await Promise.all([getSettings(), listMyBookings(user.id, { past: true, limit: 100 })]);
  const tz = settings.timezone;

  const groups: Array<{ date: string; label: string; items: BookingWithTrip[] }> = [];
  for (const b of bookings) {
    const last = groups[groups.length - 1];
    if (last && last.date === b.trip.service_date) last.items.push(b);
    else groups.push({ date: b.trip.service_date, label: formatShortDate(b.trip.departure_at, tz), items: [b] });
  }
  const rides = bookings.filter((b) => b.status === "boarded" || b.status === "confirmed").length;
  const noShows = bookings.filter((b) => b.status === "no_show").length;

  return (
    <Page>
      <AppHeader back="/app" title="History" greeting="Your past trips" />

      {bookings.length === 0 ? (
        <Card>
          <Empty
            art="receipt"
            title="No trips yet"
            hint="Seats you book show up here after the shuttle has left."
            action={
              <Button pill variant="secondary" href="/app">
                {"🚌 See today's shuttles"}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="k-grid-2">
            <StatTile value={rides} label="Rides" art="bus" zero={rides === 0} />
            <StatTile value={noShows} label="No-shows" art="clock" zero={noShows === 0} danger={noShows > 0} />
          </div>
          {groups.map((g) => (
            <List key={g.date} caption={g.label}>
              {g.items.map((b) => (
                <Row
                  key={b.id}
                  href={`/app/trips/${b.trip.id}`}
                  leading={<Art k="bus" size={32} />}
                  title={`${formatTime(b.trip.departure_at, tz)} · ${directionShort(b.trip.direction)}`}
                  subtitle={[b.pickup_location?.name, `${formatFare(settings.fare_pesewas, settings.currency)} cash`].filter(Boolean).join(" · ")}
                  trailing={
                    <Pill tone={BOOKING_STATUS_TONE[b.status]} sm>
                      {BOOKING_STATUS_LABEL[b.status]}
                    </Pill>
                  }
                />
              ))}
            </List>
          ))}
        </>
      )}
    </Page>
  );
}
