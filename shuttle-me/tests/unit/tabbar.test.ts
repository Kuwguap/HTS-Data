import { describe, expect, it } from "vitest";
import { activeTabHref } from "@/components/layout/TabBar";

const ADMIN_TABS = [
  { href: "/admin" },
  { href: "/admin/schedule" },
  { href: "/admin/locations" },
  { href: "/admin/users" },
  { href: "/admin/more", match: ["/admin/trips", "/admin/days-off", "/admin/broadcast", "/admin/templates", "/admin/reports", "/admin/settings", "/admin/account"] },
];

describe("activeTabHref", () => {
  it("keeps the bare /admin exact for Overview", () => {
    expect(activeTabHref("/admin", ADMIN_TABS)).toBe("/admin");
    expect(activeTabHref("/admin/more", ADMIN_TABS)).toBe("/admin/more");
  });

  it("highlights More for the /admin/* pages it owns via match, including nested paths", () => {
    expect(activeTabHref("/admin/trips", ADMIN_TABS)).toBe("/admin/more");
    expect(activeTabHref("/admin/trips/8d6b4b2a-0000-4000-8000-000000000000", ADMIN_TABS)).toBe("/admin/more");
    expect(activeTabHref("/admin/settings", ADMIN_TABS)).toBe("/admin/more");
    expect(activeTabHref("/admin/account", ADMIN_TABS)).toBe("/admin/more");
    expect(activeTabHref("/admin/days-off", ADMIN_TABS)).toBe("/admin/more");
  });

  it("still prefers a tab's own href over a parent tab, and ignores lookalike prefixes", () => {
    expect(activeTabHref("/admin/users?role=driver".split("?")[0]!, ADMIN_TABS)).toBe("/admin/users");
    expect(activeTabHref("/admin/schedule", ADMIN_TABS)).toBe("/admin/schedule");
    // "/admin/userspace" is not under "/admin/users": it falls back to the bare "/admin".
    expect(activeTabHref("/admin/userspace", ADMIN_TABS)).toBe("/admin");
  });

  it("accepts plain href strings and returns null when nothing matches", () => {
    expect(activeTabHref("/app/inbox/123", ["/app", "/app/live", "/app/inbox", "/app/settings"])).toBe("/app/inbox");
    expect(activeTabHref("/login", ["/app", "/app/live"])).toBeNull();
  });
});
