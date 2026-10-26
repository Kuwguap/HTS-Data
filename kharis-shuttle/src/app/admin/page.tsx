import Link from "next/link";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { TickButton } from "@/components/admin/TickButton";
import { Art, Banner, Caption, Empty, List, Pill, Row, StatTile } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/require";
import { overview } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { formatAgo, formatShortDate, formatTime } from "@/lib/time";
import { directionShort, TRIP_STATUS_LABEL, TRIP_STATUS_TONE } from "@/lib/trips";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const now = new Date();
  const [ctx, settings, data] = await Promise.all([getAuthContext(), getSettings(), overview(now)]);
  const tick = data.tick;
  const tickAgeMin = tick.ageSeconds == null ? null : Math.round(tick.ageSeconds / 60);
  const tickValue = tick.last ? (tick.ok ? "ok" : "⚠️") : "—";
  const tickLabel = tick.last
    ? tick.ok
      ? `Tick · ${formatAgo(tick.last.ran_at, now)}`
      : `No tick for ${tickAgeMin} min`
    : "No tick yet";
  const firstName = ctx?.profile.full_name.split(" ")[0] ?? "";

  return (
    <Page>
      <AppHeader title="Overview" greeting={`${settings.hostel_name}${firstName ? ` · ${firstName}` : ""} · ${formatShortDate(now, settings.timezone)}`} />

      {!tick.ok ? (
        <Banner tone="red" icon="⚠️">
          {tick.last ? `The minute tick has not run for ${tickAgeMin} min.` : "The minute tick has never run."} Trips, reminders and pushes
          depend on it. In Supabase enable <strong>pg_cron</strong> + <strong>pg_net</strong>, apply <code>0009_cron.sql</code> and store{" "}
          <code>tick_url</code> / <code>cron_secret</code> in Vault (see supabase/README.md). As a backup, point cron-job.org at{" "}
          <code>POST /api/cron/tick</code> with the bearer secret every minute.
        </Banner>
      ) : null}

      <div className="k-grid-2">
        <StatTile tone="orange" icon="team" value={data.bookingsToday} label="Riders today" art="seat" href="/admin/trips" />
        <StatTile tone="teal" icon="bus" value={data.tripsToday.length} label="Trips today" art="bus" href="/admin/trips" />
        <StatTile tone="purple" icon="hand" value={data.pendingRequests} label="Pending requests" art="hand" href="/driver/requests" />
        <StatTile tone={tick.ok ? "green" : "red"} icon="clock" value={tickValue} label={tickLabel} art="clock" />
      </div>

      <div className="k-grid-2">
        <StatTile value={data.students} label="Active students" art="team" href="/admin/users?role=student" />
        <StatTile value={data.drivers} label="Active drivers" art="steering" href="/admin/users?role=driver" />
      </div>

      {data.pushFailures24h > 0 ? (
        <Banner tone="amber" icon="📵">
          {data.pushFailures24h} push{data.pushFailures24h === 1 ? "" : "es"} failed in the last 24 h. Check the VAPID keys if this keeps happening.
        </Banner>
      ) : null}

      <List caption="Today's trips" captionAction={<Link href="/admin/trips" className="k-link" style={{ fontSize: 13, minHeight: 0 }}>All trips ›</Link>}>
        {data.tripsToday.length === 0 ? (
          <Empty art="bus" title="No trips today" hint="Trips appear once the tick materialises the schedule, or add an extra trip." />
        ) : (
          data.tripsToday.map((t) => (
            <Row
              key={t.id}
              href={`/admin/trips/${t.id}`}
              leading={<Art k={t.direction === "to_campus" ? "campus" : "hostel"} size={32} />}
              title={`${formatTime(t.departure_at, settings.timezone)} · ${directionShort(t.direction)}`}
              subtitle={`${t.confirmed_count}/${t.seat_capacity} seats${t.waitlist_count ? ` · ${t.waitlist_count} waiting` : ""}${t.driver_name ? ` · ${t.driver_name}` : ""}`}
              trailing={
                <Pill tone={TRIP_STATUS_TONE[t.status]} sm>
                  {TRIP_STATUS_LABEL[t.status]}
                </Pill>
              }
            />
          ))
        )}
      </List>

      <Caption action={<TickButton />}>Recent ticks</Caption>
      <List>
        {tick.recent.length === 0 ? (
          <Empty art="clock" title="No ticks recorded" hint="run_tick() writes a row here every minute once pg_cron is wired up." />
        ) : (
          tick.recent.map((r) => (
            <Row
              key={r.id}
              title={`${formatTime(r.ran_at, settings.timezone)} · ${formatAgo(r.ran_at, now)}`}
              subtitle={`${r.trips_created} trips · ${r.reminders_enqueued} reminders · ${r.nudges_enqueued} nudges · ${r.manifests_enqueued} manifests · ${r.duration_ms ?? 0} ms${r.note ? ` · ${r.note}` : ""}`}
              trailing={r.note ? <Pill tone="amber" sm>Note</Pill> : <Pill tone="green" sm>OK</Pill>}
            />
          ))
        )}
      </List>
    </Page>
  );
}
