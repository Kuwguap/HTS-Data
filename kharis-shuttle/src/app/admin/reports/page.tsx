import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { ReportRange } from "@/components/admin/ReportRange";
import { Empty, List, Pill, Row, StatTile } from "@/components/ui";
import { defaultReportRange, reports } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { addDays, formatShortDate, localDateString } from "@/lib/time";
import { isoDate } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const [settings, params] = await Promise.all([getSettings(), searchParams]);
  const now = new Date();
  const tz = settings.timezone;
  const thisWeek = defaultReportRange(now, tz);
  const weekStart = new Date(`${thisWeek.from}T12:00:00Z`);
  const lastWeek = { from: localDateString(addDays(weekStart, -7), "UTC"), to: localDateString(addDays(weekStart, -1), "UTC") };
  const today = localDateString(now, tz);
  const thisMonth = { from: `${today.slice(0, 7)}-01`, to: today };
  const presets = [
    { key: "week", label: "This week", ...thisWeek },
    { key: "last", label: "Last week", ...lastWeek },
    { key: "month", label: "This month", ...thisMonth },
  ];

  const fromP = isoDate.safeParse(params.from);
  const toP = isoDate.safeParse(params.to);
  let from = fromP.success ? fromP.data : thisWeek.from;
  let to = toP.success ? toP.data : thisWeek.to;
  if (from > to) [from, to] = [to, from];

  const r = await reports({ from, to });
  const rangeLabel = `${formatShortDate(`${from}T12:00:00Z`, "UTC")} – ${formatShortDate(`${to}T12:00:00Z`, "UTC")}`;
  const csvHref = `/api/admin/reports?from=${from}&to=${to}&format=csv`;

  return (
    <Page>
      <AppHeader title="Reports" back="/admin/more" greeting={rangeLabel} />
      <ReportRange from={from} to={to} presets={presets} />

      <div className="k-grid-2">
        <StatTile tone="orange" icon="seat" value={r.totals.rides} label="Rides" art="seat" />
        <StatTile tone="teal" icon="bus" value={`${r.totals.fillPct}%`} label={`Avg fill · ${r.totals.trips} trips`} art="bus" />
        <StatTile tone={r.totals.noShowPct > 20 ? "red" : "purple"} icon="hand" value={`${r.totals.noShowPct}%`} label={`No-shows · ${r.totals.noShows}`} art="flag" />
        <StatTile value={r.totals.waitlisted} label="Left on waitlist" art="clock" zero={r.totals.waitlisted === 0} />
      </div>

      <a href={csvHref} download className="k-btn k-btn--secondary">
        ⬇️ Download CSV
      </a>

      <List caption="Per day">
        {r.perDay.length === 0 ? (
          <Empty art="calendar" title="No trips in this range" hint="Pick another range above." />
        ) : (
          r.perDay.map((d) => (
            <Row
              key={d.label}
              title={formatShortDate(`${d.label}T12:00:00Z`, "UTC")}
              subtitle={`${d.trips} trips · ${d.capacity} seats${d.noShows ? ` · ${d.noShows} no-shows` : ""}`}
              trailing={<Pill tone="blue" sm>{d.rides} rides</Pill>}
              chevron={false}
            />
          ))
        )}
      </List>

      {r.perDeparture.length > 0 ? (
        <List caption="Per departure time">
          {r.perDeparture.map((d) => (
            <Row
              key={d.label}
              title={d.label}
              subtitle={`${d.trips} trips · ${d.capacity ? Math.round((d.rides / d.capacity) * 100) : 0}% full${d.noShows ? ` · ${d.noShows} no-shows` : ""}`}
              trailing={<Pill tone="blue" sm>{d.rides} rides</Pill>}
              chevron={false}
            />
          ))}
        </List>
      ) : null}

      {r.perPickup.length > 0 ? (
        <List caption="Per pickup point">
          {r.perPickup.map((p) => (
            <Row key={p.label} title={p.label} trailing={<Pill tone="teal" sm>{p.count} rides</Pill>} chevron={false} />
          ))}
        </List>
      ) : null}

      {r.perTrip.length > 0 ? (
        <List caption="Per trip">
          {r.perTrip.map((t) => (
            <Row
              key={t.id}
              href={`/admin/trips/${t.id}`}
              title={`${t.time} · ${t.direction === "to_campus" ? "To campus" : "To hostel"}`}
              subtitle={`${formatShortDate(`${t.service_date}T12:00:00Z`, "UTC")} · ${t.rides}/${t.capacity} · ${t.status}`}
              trailing={<Pill tone={t.fillPct >= 80 ? "green" : t.fillPct >= 40 ? "amber" : "neutral"} sm>{t.fillPct}%</Pill>}
            />
          ))}
        </List>
      ) : null}
    </Page>
  );
}
