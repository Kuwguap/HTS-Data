import type { Metadata } from "next";
import { requirePageAuth } from "@/lib/auth/page";
import { listAcceptedRequestsToday, listPendingPickupRequests } from "@/lib/data/driver";
import { getSettings } from "@/lib/data/settings";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { Badge, Caption, Card, Empty } from "@/components/ui";
import { LiveRefresh } from "@/components/driver/LiveRefresh";
import { RequestCard } from "@/components/driver/RequestCard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Requests" };

/** Pending pickup requests (accept / decline) and the ones handled today. */
export default async function DriverRequestsPage() {
  await requirePageAuth({ role: "driver" });
  const [settings, pending, accepted] = await Promise.all([getSettings(), listPendingPickupRequests(), listAcceptedRequestsToday()]);

  return (
    <Page>
      <AppHeader title="Requests" greeting="Pickups" right={pending.length > 0 ? <Badge count={pending.length} label="pending" /> : null} />
      <LiveRefresh table="pickup_requests" />

      <Caption>✋ Waiting for you · {pending.length}</Caption>
      {pending.length === 0 ? (
        <Card>
          <Empty art="hand" title="No pickup requests" hint="When a student asks to be picked up somewhere, it shows up here and on your tracking screen." />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {pending.map((r) => (
            <RequestCard key={r.id} request={r} timezone={settings.timezone} />
          ))}
        </div>
      )}

      {accepted.length > 0 ? (
        <>
          <Caption>Handled today · {accepted.length}</Caption>
          <div className="flex flex-col gap-3">
            {accepted.map((r) => (
              <RequestCard key={r.id} request={r} timezone={settings.timezone} />
            ))}
          </div>
        </>
      ) : null}
    </Page>
  );
}
