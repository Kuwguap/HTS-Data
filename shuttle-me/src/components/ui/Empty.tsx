import type { ReactNode } from "react";
import type { ArtKey } from "@/lib/constants";
import { Art } from "./Art";

export type EmptyProps = {
  art?: ArtKey;
  /** Custom glyph instead of an art key. */
  emoji?: string;
  title: ReactNode;
  hint?: ReactNode;
  /** Usually a `<Button>`. */
  action?: ReactNode;
  className?: string;
};

/** Centred empty state: 56px art, bold title, grey hint, optional action. */
export function Empty({ art, emoji, title, hint, action, className }: EmptyProps) {
  return (
    <div className={["k-empty", className ?? ""].join(" ").trim()}>
      <Art k={art} emoji={emoji} size={56} />
      <div className="k-empty-title">{title}</div>
      {hint ? <div className="k-empty-hint">{hint}</div> : null}
      {action ? <div style={{ marginTop: 10 }}>{action}</div> : null}
    </div>
  );
}
