"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { ArtKey } from "@/lib/constants";
import { Art } from "./Art";
import type { GradTone } from "./HeroCard";

export type StatTileProps = {
  /** Big 32px number/text. */
  value: ReactNode;
  /** Small label under the value. */
  label: ReactNode;
  /** 3D art in the bottom-right corner. */
  art?: ArtKey;
  /** Small glyph at the top-left (gradient tiles in the reference show one). */
  icon?: ArtKey;
  /** `outline` = white tile with blue outline and blue number; a gradient key = coloured tile with white text. */
  tone?: "outline" | GradTone;
  /** Zero state: drops the outline and greys the number. */
  zero?: boolean;
  /** Danger state: red outline + red number (e.g. "0 seats left"). */
  danger?: boolean;
  href?: string;
  onClick?: () => void;
  className?: string;
};

/** 2×2 stat tile. Put several in a `<div className="k-grid-2">`. */
export function StatTile({ value, label, art, icon, tone = "outline", zero, danger, href, onClick, className }: StatTileProps) {
  const grad = tone !== "outline";
  const cls = [
    "k-tile",
    grad ? `k-tile--grad grad-${tone}` : "",
    !grad && zero ? "k-tile--zero" : "",
    !grad && danger ? "k-tile--danger" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const valueStyle: CSSProperties | undefined = grad ? undefined : danger ? { color: "var(--danger)" } : zero ? { color: "var(--hint)" } : undefined;
  const body = (
    <>
      {icon ? (
        <div style={{ marginBottom: "auto", position: "relative", zIndex: 1 }}>
          <Art k={icon} size={26} />
        </div>
      ) : null}
      <div className="k-tile-value" style={{ position: "relative", zIndex: 1, ...valueStyle }}>
        {value}
      </div>
      <div className="k-tile-label" style={{ position: "relative", zIndex: 1, paddingRight: art ? 44 : 0 }}>
        {label}
      </div>
      {art ? (
        <div className="k-tile-art">
          <Art k={art} size={72} />
        </div>
      ) : null}
    </>
  );
  const style: CSSProperties = { color: grad ? undefined : "inherit", textAlign: "left", width: "100%" };
  if (href) {
    return (
      <Link href={href} className={cls} style={style}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} style={style} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}
