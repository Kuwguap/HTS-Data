import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { LogoutRow } from "@/components/admin/LogoutRow";
import { Art, List, Row } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { APP_NAME } from "@/lib/constants";
import { getSettings } from "@/lib/data/settings";

export const dynamic = "force-dynamic";

export default async function AdminMorePage() {
  const ctx = await requirePageAuth({ role: "admin" });
  const settings = await getSettings();
  return (
    <Page>
      <AppHeader title="More" greeting={`${settings.hostel_name} · ${ctx.profile.full_name}`} />

      <List caption="Operations">
        <Row nav href="/admin/trips" leading={<Art k="bus" size={32} />} title="Trips" subtitle="Today's departures, extra trips, cancellations" />
        <Row nav href="/admin/days-off" leading={<Art k="calendar" size={32} />} title="Days off" subtitle="Holidays and no-service days" />
        <Row nav href="/admin/broadcast" leading={<Art k="megaphone" size={32} />} title="Send announcement" subtitle="Push a message to students or drivers" />
      </List>

      <List caption="Setup">
        <Row nav href="/admin/templates" leading={<Art k="chat" size={32} />} title="Message templates" subtitle="Wording of every reminder" />
        <Row nav href="/admin/reports" leading={<Art k="receipt" size={32} />} title="Reports" subtitle="Ridership, fill rate, no-shows, CSV" />
        <Row nav href="/admin/settings" leading={<Art k="gear" size={32} />} title="Settings" subtitle="Fare, seats, reminders, join code" />
      </List>

      <List caption="Me">
        <Row nav href="/driver" leading={<Art k="steering" size={32} />} title="Driver view" subtitle="Manifests, tracking and requests" />
        <Row nav href="/admin/account" leading={<Art k="roles" size={32} />} title="My account" subtitle="Name, phone, PIN" />
        <LogoutRow />
      </List>

      <p className="k-help" style={{ textAlign: "center" }}>
        {APP_NAME} · admin console
      </p>
    </Page>
  );
}
