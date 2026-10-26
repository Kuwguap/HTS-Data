"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export type BannerTone = "amber" | "blue" | "red" | "green";

export type BannerProps = {
  tone?: BannerTone;
  /** Leading emoji/glyph. */
  icon?: ReactNode;
  children: ReactNode;
  /** Optional right-aligned action: a link (`href`) or a button (`onClick`). */
  action?: { label: ReactNode; href?: string; onClick?: () => void };
  onDismiss?: () => void;
  className?: string;
};

/** Slim tinted strip for warnings and hints ("Reminders are off"). */
export function Banner({ tone = "amber", icon, children, action, onDismiss, className }: BannerProps) {
  // 44px tall tap target; the −6px vertical margin keeps the strip at the height a 32px control gave it.
  const actionStyle = {
    fontWeight: 700,
    color: "inherit",
    textDecoration: "underline",
    textUnderlineOffset: 3,
    whiteSpace: "nowrap" as const,
    minHeight: 44,
    minWidth: 44,
    margin: "-6px 0",
    padding: "0 2px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
  };
  return (
    <div className={["k-banner", tone !== "amber" ? `k-banner--${tone}` : "", className ?? ""].filter(Boolean).join(" ")} role="status">
      {icon ? <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span> : null}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {action ? (
        action.href ? (
          <Link href={action.href} style={actionStyle}>
            {action.label}
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} style={actionStyle}>
            {action.label}
          </button>
        )
      ) : null}
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="k-hit k-hit--28" style={{ color: "inherit", opacity: 0.7 }}>
          <span className="k-hit-face" aria-hidden="true" style={{ width: 28, height: 28 }}>
            ✕
          </span>
        </button>
      ) : null}
    </div>
  );
}
