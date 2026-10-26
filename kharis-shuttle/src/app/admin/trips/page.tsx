import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { AdhocTripSheet } from "@/components/admin/AdhocTripSheet";
import { DateNav } from "@/components/admin/DateNav";
import { Art, Empty, List, Pill, Row } from "@/components/ui";
import { listDrivers, listTrips } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { formatTime, localDateString } from "@/lib/time";
import { directionShort, TRIP_STATUS_LABEL, TRIP_STATUS_TONE } from "@/lib/trips";
import { isoDate } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export default async function AdminTripsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const [settings, params] = await Promise.all([getSettings(), searchParams]);
  const today = localDateString(new Date(), settings.timezone);
  const parsed = isoDate.safeParse(params.date ?? today);
  const date = parsed.success ? parsed.data : today;
  const [trips, drivers] = await Promise.all([listTrips({ from: date, to: date }), listDrivers()]);
  const riders = trips.reduce((n, t) => n + t.confirmed_count, 0);

  return (
    <Page>
      <AppHeader title="Trips" back="/admin/more" greeting={`${trips.length} trips · ${riders} riders`} />
      <DateNav date={date} today={today} timeZone={settings.timezone} basePath="/admin/trips" />

      <List caption="Departures">
        {trips.length === 0 ? (
          <Empty art="bus" title="No trips on this day" hint="Scheduled trips appear once the tick creates them (a day ahead). Add an extra trip below." />
        ) : (
          trips.map((t) => (
            <Row
              key={t.id}
              href={`/admin/trips/${t.id}`}
              leading={<Art k={t.direction === "to_campus" ? "campus" : "hostel"} size={32} />}
              title={`${formatTime(t.departure_at, settings.timezone)} · ${directionShort(t.direction)}`}
              subtitle={`${t.confirmed_count}/${t.seat_capacity} seats${t.waitlist_count ? ` · ${t.waitlist_count} waiting` : ""} · ${t.driver_name ?? "No driver"}${t.schedule_time_id ? "" : " · extra"}`}
              trailing={
                <Pill tone={TRIP_STATUS_TONE[t.status]} sm>
                  {TRIP_STATUS_LABEL[t.status]}
                </Pill>
              }
            />
          ))
        )}
      </List>

      <AdhocTripSheet
        date={date}
        timeZone={settings.timezone}
        hostelName={settings.hostel_name}
        campusName={settings.campus_name}
        defaultCapacity={settings.default_seat_capacity}
        drivers={drivers}
        defaultDriverId={settings.default_driver_id}
      />
    </Page>
  );
}
