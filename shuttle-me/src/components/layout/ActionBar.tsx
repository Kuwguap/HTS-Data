import type { ReactNode } from "react";

export type ActionBarProps = {
  children: ReactNode;
  /** Sits right above the safe area when there is no tab bar. */
  noTabs?: boolean;
  className?: string;
};

/** Sticky bottom strip for the primary action (fades the content behind it). */
export function ActionBar({ children, noTabs, className }: ActionBarProps) {
  return (
    <div className={["k-actionbar", noTabs ? "k-actionbar--no-tabs" : "", className ?? ""].filter(Boolean).join(" ")}>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
