import type { ReactNode } from "react";

export type CaptionProps = {
  children: ReactNode;
  /** Right-aligned extra (a link or count). */
  action?: ReactNode;
  className?: string;
};

/** Small uppercase grey section header above a list or grid. */
export function Caption({ children, action, className }: CaptionProps) {
  return (
    <div className={["k-caption flex items-center justify-between gap-2", className ?? ""].join(" ").trim()}>
      <span>{children}</span>
      {action ? <span style={{ textTransform: "none", letterSpacing: 0 }}>{action}</span> : null}
    </div>
  );
}
