export type SpinnerProps = {
  /** Diameter in px. */
  size?: number;
  className?: string;
  /** Accessible label; defaults to "Loading". */
  label?: string;
};

/** A small rotating ring in `currentColor` (SMIL animation, no CSS needed). */
export function Spinner({ size = 20, className, label = "Loading" }: SpinnerProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="status"
      aria-label={label}
      style={{ flex: "0 0 auto" }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}
