import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type PillTone = "neutral" | "blue" | "green" | "amber" | "red" | "purple" | "teal" | "ghost";

export type PillProps = ComponentPropsWithoutRef<"span"> & {
  tone?: PillTone;
  /** 22px tall variant for dense rows. */
  sm?: boolean;
  children: ReactNode;
};

/** Tinted status chip ("Confirmed", "Waitlist #2", "Cash only"). Not a button: use `<Button pill>` for actions. */
export function Pill({ tone = "neutral", sm, className, children, ...rest }: PillProps) {
  const cls = ["k-pill", tone !== "neutral" ? `k-pill--${tone}` : "", sm ? "k-pill--sm" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
