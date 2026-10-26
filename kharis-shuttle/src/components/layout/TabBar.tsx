"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ArtKey } from "@/lib/constants";
import { Art } from "@/components/ui/Art";
import { Badge } from "@/components/ui/Badge";

export type TabItem = {
  href: string;
  label: string;
  art: ArtKey;
  /** Red count badge (unread inbox, pending requests). */
  badge?: number | null;
};

export type TabBarProps = {
  items: TabItem[];
  className?: string;
};

/** The tab whose href is the longest prefix of the pathname is active. */
export function activeTabHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = pathname === href || pathname.startsWith(href.endsWith("/") ? href : href + "/");
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

/**
 * Fixed bottom tab bar: art icon over a tiny uppercase label, red badges.
 *
 * ```tsx
 * <TabBar items={[
 *   { href: "/app", label: "Today", art: "bus" },
 *   { href: "/app/live", label: "Live", art: "track" },
 *   { href: "/app/inbox", label: "Inbox", art: "chat", badge: 3 },
 *   { href: "/app/settings", label: "Me", art: "roles" },
 * ]} />
 * ```
 */
export function TabBar({ items, className }: TabBarProps) {
  const pathname = usePathname() ?? "";
  const active = activeTabHref(pathname, items.map((i) => i.href));
  return (
    <nav className={["k-tabbar", className ?? ""].join(" ").trim()} aria-label="Main">
      <div className="k-tabbar-row">
        {items.map((item) => (
          <Link key={item.href} href={item.href} className="k-tab" aria-current={item.href === active ? "page" : undefined}>
            <span className="k-tab-icon">
              <Art k={item.art} size={24} />
            </span>
            <span>{item.label}</span>
            <Badge count={item.badge} label={item.label.toLowerCase()} />
          </Link>
        ))}
      </div>
    </nav>
  );
}
