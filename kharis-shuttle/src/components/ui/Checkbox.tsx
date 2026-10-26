"use client";

import type { ReactNode } from "react";

export type CheckboxProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Text next to the circle; the whole row is tappable. */
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
};

/** Round blue check ("✅ I'll pay the driver in cash"). */
export function Checkbox({ checked, onChange, label, hint, disabled, className }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={["flex items-center gap-3 w-full text-left", className ?? ""].join(" ").trim()}
      style={{ minHeight: 44, opacity: disabled ? 0.5 : 1 }}
      onClick={() => onChange(!checked)}
    >
      <span className={["k-check", checked ? "k-check--on" : ""].join(" ").trim()} aria-hidden="true">
        {checked ? (
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M2.5 7.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "var(--fs-lg)" }}>{label}</span>
        {hint ? <span style={{ display: "block", color: "var(--hint)", fontSize: "var(--fs-sm)", marginTop: 2 }}>{hint}</span> : null}
      </span>
    </button>
  );
}
