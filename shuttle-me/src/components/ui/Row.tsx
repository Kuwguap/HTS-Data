"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

export type RowProps = {
  /** Main 17px text (title mode). */
  title?: ReactNode;
  /** Grey 15px line under the title. */
  subtitle?: ReactNode;
  /** Label/value mode: grey label left, value right ("Fare" · "GH₵10"). */
  label?: ReactNode;
  value?: ReactNode;
  /** Left slot: an <Art>, <Avatar>, <Checkbox>… */
  leading?: ReactNode;
  /** Right slot: a <Pill>, <Switch>, <Button pill>… */
  trailing?: ReactNode;
  /** Grey chevron on the far right. Defaults to true when `href` is set. */
  chevron?: boolean;
  /** Renders the row as a link. */
  href?: string;
  /** Renders the row as a button. */
  onClick?: () => void;
  disabled?: boolean;
  /** 64px tall nav row. */
  nav?: boolean;
  /** Selected state for pick-lists (adds the blue tint). */
  selected?: boolean;
  role?: string;
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export function Chevron() {
  return (
    <svg className="k-chevron" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
      <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One line of a grouped `<List>`. Pressable when `href` or `onClick` is set
 * (renders a link/button with the grey press state and proper semantics).
 */
export function Row({
  title,
  subtitle,
  label,
  value,
  leading,
  trailing,
  chevron,
  href,
  onClick,
  disabled,
  nav,
  selected,
  role,
  className,
  style,
  children,
  ...aria
}: RowProps) {
  const interactive = Boolean(href || onClick);
  const showChevron = chevron ?? Boolean(href);
  const cls = [
    "k-row",
    nav ? "k-row--nav" : "",
    interactive ? "k-row--press" : "",
    selected != null ? "k-pick" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const inner = (
    <>
      {leading}
      {label != null ? (
        <>
          <span className="k-row-label">{label}</span>
          <span className="k-row-value">{value}</span>
        </>
      ) : (
        <span className="k-row-main">
          {title != null ? <span className="k-row-title" style={{ display: "block" }}>{title}</span> : null}
          {subtitle != null ? <span className="k-row-sub" style={{ display: "block" }}>{subtitle}</span> : null}
          {children}
        </span>
      )}
      {trailing != null && trailing !== false ? <span className="k-row-trailing">{trailing}</span> : null}
      {showChevron ? <Chevron /> : null}
    </>
  );

  const ariaChecked = selected != null ? selected : undefined;
  const baseStyle: CSSProperties = { width: "100%", textAlign: "left", color: "inherit", ...style };

  if (href && !disabled) {
    return (
      <Link href={href} className={cls} style={baseStyle} role={role} aria-label={aria["aria-label"]}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        style={baseStyle}
        onClick={onClick}
        disabled={disabled}
        role={role ?? (selected != null ? "radio" : undefined)}
        aria-checked={ariaChecked}
        aria-label={aria["aria-label"]}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={cls} style={style} role={role} aria-checked={ariaChecked} aria-label={aria["aria-label"]}>
      {inner}
    </div>
  );
}
