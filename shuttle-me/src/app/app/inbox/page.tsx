import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { InboxList, type InboxItem } from "@/components/trips/InboxList";
import { Badge } from "@/components/ui";
import { requirePageAuth } from "@/lib/auth/page";
import { getSettings } from "@/lib/data/settings";
import { listNotifications } from "@/lib/data/student";
import { formatDayLabel, formatTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { user } = await requirePageAuth();
  const [settings, notifications] = await Promise.all([getSettings(), listNotifications(user.id, { limit: 50 })]);
  const now = new Date();
  const tz = settings.timezone;

  const items: InboxItem[] = notifications.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    url: n.url,
    dayLabel: formatDayLabel(n.created_at, now, tz),
    timeLabel: formatTime(n.created_at, tz),
    unread: n.read_at === null,
  }));
  const unread = items.filter((i) => i.unread).length;

  return (
    <Page>
      <AppHeader title="Inbox" right={unread > 0 ? <Badge count={unread} label="unread" /> : undefined} />
      <InboxList items={items} />
    </Page>
  );
}
