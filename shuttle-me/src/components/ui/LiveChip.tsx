export type LiveChipProps = {
  /** Green pulsing dot when true, grey static dot when false. */
  live: boolean;
  /** Text; defaults to "Live" / "Off". Rendered uppercase by CSS. */
  label?: string;
  className?: string;
};

/** The green LIVE chip from the Krab header ("● LIVE"). */
export function LiveChip({ live, label, className }: LiveChipProps) {
  return (
    <span className={["k-live", live ? "" : "k-live--off", className ?? ""].filter(Boolean).join(" ")} aria-live="polite">
      {label ?? (live ? "Live" : "Off")}
    </span>
  );
}
