export type SkeletonProps = {
  /** Number of shimmering lines. */
  lines?: number;
  /** Per-line widths (CSS values); cycles when shorter than `lines`. */
  widths?: string[];
  /** Line height in px. */
  height?: number;
  /** Wrap the lines in a white card. */
  card?: boolean;
  className?: string;
};

/** Shimmering placeholder lines while data loads. */
export function Skeleton({ lines = 3, widths = ["70%", "45%", "85%"], height = 12, card, className }: SkeletonProps) {
  const rows = Array.from({ length: lines }, (_, i) => (
    <div key={i} className="k-skeleton" style={{ width: widths[i % widths.length], height }} />
  ));
  const body = (
    <div className={["flex flex-col gap-3", className ?? ""].join(" ").trim()} aria-busy="true" aria-live="polite">
      {rows}
    </div>
  );
  return card ? <div className="k-card">{body}</div> : body;
}
