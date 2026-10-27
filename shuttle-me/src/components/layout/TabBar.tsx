"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ArtKey } from "@/lib/constants";
import { Art } from "@/components/ui/Art";
import { Badge } from "@/components/ui/Badge";

export type TabItem = {
  href: string;
  label: string;
  art: ArtKey;
  /** Red count badge (unread inbox, pending requests). */
  badge?: number | null;
  /** Noun for the badge in the link's accessible name ("Inbox, 3 unread"). Default "unread". */
  badgeLabel?: string;
  /**
   * Extra path prefixes this tab owns besides `href` (e.g. the admin More tab owns
   * "/admin/trips", "/admin/settings", …). An explicit match beats a shorter tab href
   * such as the bare "/admin", which stays exact for Overview.
   */
  match?: string[];
};

/** Accessible name for a tab link: "Inbox", or "Inbox, 3 unread" when a badge shows. */
export function tabAccessibleName(item: Pick<TabItem, "label" | "badge" | "badgeLabel">): string {
  const n = item.badge ?? 0;
  if (n <= 0) return item.label;
  return `${item.label}, ${n > 99 ? "99+" : n} ${item.badgeLabel ?? "unread"}`;
}

export type TabBarProps = {
  items: TabItem[];
  className?: string;
};

function isPrefixOf(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

/**
 * The tab whose href (or one of its extra `match` prefixes) is the longest prefix of
 * the pathname is active. Longest wins, so an explicit match such as "/admin/trips"
 * on the More tab beats the bare "/admin" of Overview, while "/admin" itself stays
 * with Overview. Plain strings are accepted as tabs with no extra matches.
 */
export function activeTabHref(pathname: string, tabs: ReadonlyArray<string | Pick<TabItem, "href" | "match">>): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const tab of tabs) {
    const { href, match } = typeof tab === "string" ? { href: tab, match: undefined } : tab;
    for (const prefix of [href, ...(match ?? [])]) {
      if (isPrefixOf(pathname, prefix) && prefix.length > bestLength) {
        best = href;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** The tab the user just tapped, remembered together with the pathname it was tapped on. */
export type TabTap = { href: string; pathname: string };

/**
 * Which tab to highlight: a tab tapped on this very pathname wins (optimistic, so
 * the highlight moves the instant the finger lands), and the moment `usePathname()`
 * reports a new route the tap is stale by construction and the real match applies.
 * No effect or reset is needed: a tap recorded on another pathname is ignored.
 */
export function highlightedTabHref(pathname: string, tabs: ReadonlyArray<string | Pick<TabItem, "href" | "match">>, tap: TabTap | null): string | null {
  if (tap && tap.pathname === pathname) return tap.href;
  return activeTabHref(pathname, tabs);
}

/**
 * Inside each Link: icon, label and badge. `useLinkStatus` (must be a descendant of
 * the Link) pulses the icon while the navigation is still pending, i.e. when the
 * loading boundary was not prefetched yet, which is common on a slow network.
 */
function TabFace({ item }: { item: TabItem }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span className={pending ? "k-tab-icon k-tab-icon--pending" : "k-tab-icon"} aria-hidden="true">
        <Art k={item.art} size={24} />
      </span>
      <span aria-hidden="true">{item.label}</span>
      <Badge count={item.badge} decorative />
    </>
  );
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
  const [tap, setTap] = useState<TabTap | null>(null);
  const active = highlightedTabHref(pathname, items, tap);
  return (
    <nav className={["k-tabbar", className ?? ""].join(" ").trim()} aria-label="Main">
      <div className="k-tabbar-row">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="k-tab"
            aria-current={item.href === active ? "page" : undefined}
            aria-label={tabAccessibleName(item)}
            onClick={() => setTap({ href: item.href, pathname })}
          >
            <TabFace item={item} />
          </Link>
        ))}
      </div>
    </nav>
  );
}
