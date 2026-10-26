export type BadgeProps = {
  /** Count to show. Renders nothing for 0 / null. Caps at "99+". */
  count?: number | null;
  /** Accessible wording, e.g. "unread". */
  label?: string;
  className?: string;
};

/** Red count badge (tab bar, inbox rows). */
export function Badge({ count, label, className }: BadgeProps) {
  if (!count || count <= 0) return null;
  const text = count > 99 ? "99+" : String(count);
  return (
    <span className={["k-badge", className ?? ""].join(" ").trim()} aria-label={label ? `${text} ${label}` : undefined}>
      {text}
    </span>
  );
}
