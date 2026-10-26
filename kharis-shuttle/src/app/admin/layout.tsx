import type { ReactNode } from "react";
import { TabBar } from "@/components/layout/TabBar";
import { requirePageAuth } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

/** Admin console shell: admin-only, bottom tabs Overview · Schedule · Places · People · More. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePageAuth({ role: "admin" });
  return (
    <>
      {children}
      <TabBar
        items={[
          { href: "/admin", label: "Overview", art: "gear" },
          { href: "/admin/schedule", label: "Schedule", art: "clock" },
          { href: "/admin/locations", label: "Places", art: "pin" },
          { href: "/admin/users", label: "People", art: "team" },
          { href: "/admin/more", label: "More", art: "memo" },
        ]}
      />
    </>
  );
}
