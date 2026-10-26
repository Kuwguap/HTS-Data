"use client";

import type { ReactNode } from "react";

export type SegmentOption<V extends string> = { value: V; label: ReactNode; disabled?: boolean };

export type SegmentedControlProps<V extends string> = {
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  "aria-label"?: string;
  className?: string;
};

/** iOS segmented control: grey pill track, white raised segment for the selection. */
export function SegmentedControl<V extends string>({ options, value, onChange, className, ...aria }: SegmentedControlProps<V>) {
  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      className={["flex rounded-pill bg-surface-3 p-[3px]", className ?? ""].join(" ").trim()}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={["flex-1 rounded-pill text-sm font-semibold transition-colors", active ? "bg-surface text-ink shadow-card" : "text-hint"].join(" ")}
            style={{ minHeight: 36, padding: "0 10px", opacity: o.disabled ? 0.5 : 1 }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
