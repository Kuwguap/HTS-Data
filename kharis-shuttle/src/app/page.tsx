import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { loadSettingsSafe, loadTodaySchedule } from "@/components/auth/settings-safe";
import { Art } from "@/components/ui/Art";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { HeroCard } from "@/components/ui/HeroCard";
import { List } from "@/components/ui/List";
import { Pill } from "@/components/ui/Pill";
import { Row } from "@/components/ui/Row";
import type { ScheduleTime } from "@/lib/db.types";
import { APP_NAME } from "@/lib/constants";
import { formatClock, formatShortDate } from "@/lib/time";
import { fareLine } from "@/lib/trips";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: APP_NAME },
};

function DepartureRows({ times, fare }: { times: ScheduleTime[]; fare: string }) {
  return (
    <>
      {times.map((t) => (
        <Row
          key={t.id}
          leading={<Art k="bus" size={32} />}
          title={formatClock(t.depart_time)}
          subtitle={t.label ? `${t.label} · ${fare}` : fare}
          trailing={t.bookings_enabled ? <Pill tone="blue" sm>Book in app</Pill> : <Pill sm>Walk-up</Pill>}
        />
      ))}
    </>
  );
}

export default async function LandingPage() {
  const settings = await loadSettingsSafe();
  const now = new Date();
  const today = await loadTodaySchedule(settings, now);
  const fare = fareLine(settings);
  const hasTimes = today.toCampus.length > 0 || today.toHostel.length > 0;
  const dateLabel = formatShortDate(now, settings.timezone);

  return (
    <Page noTabs>
      <AppHeader greeting={APP_NAME} title={`🚌 ${settings.hostel_name} shuttle`} />

      <HeroCard
        tone="blue"
        title="Reserve your seat"
        subtitle={`Reminders before each departure · live bus tracking · ${fare}`}
        art="bus"
      />

      {today.dayOff ? (
        <div className="k-card">
          <Empty art="calendar" title="No shuttle today" hint={today.dayOff.reason ?? `${dateLabel} is a day off. Check again tomorrow.`} />
        </div>
      ) : hasTimes ? (
        <>
          {today.toCampus.length > 0 ? (
            <List caption={`Today · to ${settings.campus_name}`} captionAction={<span style={{ color: "var(--hint)", fontSize: 13 }}>{dateLabel}</span>}>
              <DepartureRows times={today.toCampus} fare={fare} />
            </List>
          ) : null}
          {today.toHostel.length > 0 ? (
            <List caption={`Today · back to ${settings.hostel_name}`}>
              <DepartureRows times={today.toHostel} fare={fare} />
            </List>
          ) : null}
        </>
      ) : (
        <div className="k-card">
          <Empty
            art="calendar"
            title="No departures listed for today"
            hint="Open the app to see the next shuttle, or call the hostel office."
          />
        </div>
      )}

      <List caption="Fare & payment">
        <Row leading={<Art k="cash" size={32} />} label="Fare" value={fare} />
        <Row leading={<Art k="receipt" size={32} />} title="How to pay" subtitle={settings.payment_note} />
        {settings.enquiry_phone ? (
          <Row
            leading={<Art k="phone" size={32} />}
            label="Enquiries"
            value={<a href={`tel:${settings.enquiry_phone.replace(/\s+/g, "")}`}>{settings.enquiry_phone}</a>}
          />
        ) : null}
      </List>

      <div className="flex flex-col gap-2" style={{ marginTop: 4 }}>
        <Button size="big" href="/login">
          🚌 Open the app
        </Button>
        <Button variant="secondary" href="/register">
          ✨ Create account
        </Button>
        <Link href="/install" className="k-link" style={{ justifyContent: "center", fontSize: "var(--fs-md)" }}>
          📱 Install on iPhone
        </Link>
      </div>
    </Page>
  );
}
