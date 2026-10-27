export type BadgeProps = {
  /** Count to show. Renders nothing for 0 / null. Caps at "99+". */
  count?: number | null;
  /** Accessible wording, e.g. "unread". */
  label?: string;
  /** Purely decorative: the parent already names the count (tab bar links). */
  decorative?: boolean;
  className?: string;
};

/** Red count badge (tab bar, inbox rows). */
export function Badge({ count, label, decorative, className }: BadgeProps) {
  if (!count || count <= 0) return null;
  const text = count > 99 ? "99+" : String(count);
  return (
    <span
      className={["k-badge", className ?? ""].join(" ").trim()}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={!decorative && label ? `${text} ${label}` : undefined}
    >
      {text}
    </span>
  );
}
