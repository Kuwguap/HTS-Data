export type AvatarProps = {
  /** Full name; initials are the first letters of the first two words. */
  name: string;
  size?: number;
  className?: string;
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase() || "?";
}

/** Round blue-tinted initials disc. */
export function Avatar({ name, size = 40, className }: AvatarProps) {
  return (
    <span
      className={["k-avatar", className ?? ""].join(" ").trim()}
      style={size !== 40 ? { width: size, height: size, flexBasis: size, fontSize: Math.round(size * 0.38) } : undefined}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}
