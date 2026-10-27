import Link from "next/link";
import type { ReactNode } from "react";
import type { ArtKey } from "@/lib/constants";
import { Art } from "./Art";

export type GradTone = "blue" | "green" | "red" | "orange" | "teal" | "purple" | "slate" | "magenta" | "coral";

export type HeroCardProps = {
  tone?: GradTone;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Icon inside the white disc on the left. Defaults to `art`. */
  disc?: ArtKey;
  /** Big 3D art bleeding out of the bottom-right corner. */
  art?: ArtKey;
  /** Extra line under the subtitle, e.g. a translucent pill or a small button. */
  cta?: ReactNode;
  /** Makes the whole card a link. */
  href?: string;
  className?: string;
  children?: ReactNode;
};

/** Gradient hero tile: white disc + icon, bold title, subtitle and 3D art bottom-right. */
export function HeroCard({ tone = "blue", title, subtitle, disc, art, cta, href, className, children }: HeroCardProps) {
  const discKey = disc ?? art;
  const body = (
    <>
      {discKey ? (
        <div className="k-hero-disc">
          <Art k={discKey} size={40} />
        </div>
      ) : null}
      <div style={{ flex: 1, minWidth: 0, position: "relative", zIndex: 1, paddingRight: art ? 84 : 0 }}>
        <div className="k-hero-title">{title}</div>
        {subtitle ? <div className="k-hero-sub">{subtitle}</div> : null}
        {cta ? <div style={{ marginTop: 10 }}>{cta}</div> : null}
        {children}
      </div>
      {art ? (
        <div className="k-hero-art">
          <Art k={art} size={120} />
        </div>
      ) : null}
    </>
  );
  const cls = ["k-hero", `grad-${tone}`, className ?? ""].filter(Boolean).join(" ");
  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** Translucent white pill for use as a HeroCard `cta` ("🤖 Assistant on"). */
export function HeroPill({ children }: { children: ReactNode }) {
  return (
    <span
      className="k-pill"
      style={{ background: "rgba(255,255,255,0.22)", color: "inherit", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
    >
      {children}
    </span>
  );
}
