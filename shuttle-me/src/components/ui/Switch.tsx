"use client";

export type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name (required when not inside a labelled Row). */
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/** iOS-style 51×31 green toggle. */
export function Switch({ checked, onChange, label, disabled, id, className }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={["k-switch", className ?? ""].join(" ").trim()}
      style={disabled ? { opacity: 0.5 } : undefined}
      onClick={() => onChange(!checked)}
    />
  );
}
