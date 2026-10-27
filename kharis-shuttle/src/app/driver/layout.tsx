import type { ReactNode } from "react";
import { requirePageAuth } from "@/lib/auth/page";
import { pendingRequestCount } from "@/lib/data/driver";
import { TabBar } from "@/components/layout/TabBar";
import { PushResync } from "@/components/pwa/PushResync";

export const dynamic = "force-dynamic";

/** Driver shell: role gate + bottom tabs (Trips · Live · Requests · Me). */
export default async function DriverLayout({ children }: { children: ReactNode }) {
  await requirePageAuth({ role: "driver" });
  const pending = await pendingRequestCount();
  return (
    <>
      <PushResync />
      {children}
      <TabBar
        items={[
          { href: "/driver", label: "Trips", art: "bus" },
          { href: "/driver/live", label: "Live", art: "track" },
          { href: "/driver/requests", label: "Requests", art: "hand", badge: pending },
          { href: "/driver/settings", label: "Me", art: "steering" },
        ]}
      />
    </>
  );
}
