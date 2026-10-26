"use client";

import Link from "next/link";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSoft";
export type ButtonSize = "md" | "big" | "sm";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "",
  secondary: "k-btn--secondary",
  ghost: "k-btn--ghost",
  danger: "k-btn--danger",
  dangerSoft: "k-btn--danger-soft",
};

const SIZE_CLASS: Record<ButtonSize, string> = { md: "", big: "k-btn--big", sm: "k-btn--sm" };

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rounded 999px and shrink-to-content (the "Book" pill in a row). */
  pill?: boolean;
  /** Shows a spinner and disables the control. */
  loading?: boolean;
  /** Render as a link. Internal paths use next/link. */
  href?: string;
  /** With `href`: open in a new tab / treat as external. */
  external?: boolean;
  children: ReactNode;
  className?: string;
};

export type ButtonProps = Common & Omit<ComponentPropsWithoutRef<"button">, keyof Common | "children">;

/**
 * Blue pill/rounded action button in the Krab style.
 *
 * ```tsx
 * <Button size="big" onClick={save}>✅ Reserve my seat</Button>
 * <Button pill size="sm" href="/app/trips/1">Book</Button>
 * <Button variant="dangerSoft" loading={busy}>Cancel seat</Button>
 * ```
 */
export function Button({
  variant = "primary",
  size = "md",
  pill,
  loading,
  href,
  external,
  children,
  className,
  disabled,
  type,
  onClick,
  ...rest
}: ButtonProps) {
  const cls = ["k-btn", VARIANT_CLASS[variant], SIZE_CLASS[size], pill ? "k-btn--pill" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const isDisabled = Boolean(disabled || loading);
  // The face is the drawn part; for size "sm" it is the 36px pill inside a 44px tap target (see .k-btn--sm).
  const content = (
    <span className="k-btn-face">
      {loading ? <Spinner size={size === "sm" ? 14 : 18} /> : null}
      <span>{children}</span>
    </span>
  );

  if (href) {
    const anchorProps = {
      className: cls,
      "aria-disabled": isDisabled || undefined,
      "aria-busy": loading || undefined,
      style: isDisabled ? { opacity: 0.5, pointerEvents: "none" as const } : undefined,
      onClick: (e: MouseEvent<HTMLAnchorElement>) => {
        if (isDisabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e as unknown as MouseEvent<HTMLButtonElement>);
      },
    };
    if (external || !href.startsWith("/")) {
      return (
        <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} {...anchorProps}>
          {content}
        </a>
      );
    }
    return (
      <Link href={href} {...anchorProps}>
        {content}
      </Link>
    );
  }

  return (
    <button type={type ?? "button"} className={cls} disabled={isDisabled} aria-busy={loading || undefined} onClick={onClick} {...rest}>
      {content}
    </button>
  );
}
