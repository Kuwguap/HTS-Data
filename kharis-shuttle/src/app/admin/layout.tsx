import type { ReactNode } from "react";
import { TabBar } from "@/components/layout/TabBar";
import { PushResync } from "@/components/pwa/PushResync";
import { requirePageAuth } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

/** Every /admin/* page reached from More (not owned by another tab) highlights the More tab. */
const MORE_PAGES = ["/admin/trips", "/admin/days-off", "/admin/broadcast", "/admin/templates", "/admin/reports", "/admin/settings", "/admin/account"];

/** Admin console shell: admin-only, bottom tabs Overview · Schedule · Places · People · More. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePageAuth({ role: "admin" });
  return (
    <>
      <PushResync />
      {children}
      <TabBar
        items={[
          { href: "/admin", label: "Overview", art: "gear" },
          { href: "/admin/schedule", label: "Schedule", art: "clock" },
          { href: "/admin/locations", label: "Places", art: "pin" },
          { href: "/admin/users", label: "People", art: "team" },
          { href: "/admin/more", label: "More", art: "memo", match: MORE_PAGES },
        ]}
      />
    </>
  );
}
