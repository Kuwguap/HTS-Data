import type { ReactNode } from "react";
import { TabBar } from "@/components/layout/TabBar";
import { ReminderBanner } from "@/components/pwa/ReminderBanner";
import { requirePageAuth } from "@/lib/auth/page";
import { unreadCount } from "@/lib/data/student";

export const dynamic = "force-dynamic";

/** Student shell: auth gate, reminder banner, bottom tabs (Today · Live · Inbox · Me). */
export default async function StudentLayout({ children }: { children: ReactNode }) {
  const { user } = await requirePageAuth();
  const unread = await unreadCount(user.id);

  return (
    <>
      <div className="k-shell" style={{ paddingTop: 8 }}>
        <ReminderBanner />
      </div>
      {children}
      <TabBar
        items={[
          { href: "/app", label: "Today", art: "bus" },
          { href: "/app/live", label: "Live", art: "track" },
          { href: "/app/inbox", label: "Inbox", art: "chat", badge: unread },
          { href: "/app/settings", label: "Me", art: "roles" },
        ]}
      />
    </>
  );
}
