import type { ReactNode } from "react";

export type PageProps = {
  children: ReactNode;
  /** No bottom tab bar on this screen: shrinks the bottom padding. */
  noTabs?: boolean;
  className?: string;
};

/**
 * Centred 480px column with 16px gutters and a 12px stack gap. Put an
 * `<AppHeader>` first and a `<TabBar>` as a sibling of the page.
 */
export function Page({ children, noTabs, className }: PageProps) {
  return (
    <main className="k-shell">
      <div className={["k-page", noTabs ? "k-page--no-tabs" : "", className ?? ""].filter(Boolean).join(" ")}>{children}</div>
    </main>
  );
}
