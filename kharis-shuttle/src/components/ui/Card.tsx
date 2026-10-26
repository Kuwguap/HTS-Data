import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type CardProps = ComponentPropsWithoutRef<"section"> & {
  /** Optional bold 20px title inside the card. */
  title?: ReactNode;
  /** Something on the title's right (a Pill, a LiveChip, a link). */
  action?: ReactNode;
  /** Remove the 16px padding (e.g. when the card holds a map). */
  flush?: boolean;
  children?: ReactNode;
};

/** White rounded (20px) surface with the hairline shadow. */
export function Card({ title, action, flush, className, children, style, ...rest }: CardProps) {
  return (
    <section className={["k-card", className ?? ""].join(" ").trim()} style={flush ? { padding: 0, overflow: "hidden", ...style } : style} {...rest}>
      {title || action ? (
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: 10 }}>
          {title ? <h3 style={{ fontSize: 20, fontWeight: 800 }}>{title}</h3> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
