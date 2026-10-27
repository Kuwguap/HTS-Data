"use client";

import type { ReactNode } from "react";

export type FilterOption<V extends string> = { value: V; label: ReactNode; count?: number };

export type FilterPillsProps<V extends string> = {
  options: FilterOption<V>[];
  value: V;
  onChange: (value: V) => void;
  "aria-label"?: string;
  className?: string;
};

/** Horizontal row of 44px white filter pills; the active one turns blue. Scrolls sideways, bleeding to the gutters. */
export function FilterPills<V extends string>({ options, value, onChange, className, ...aria }: FilterPillsProps<V>) {
  return (
    <div
      role="group"
      aria-label={aria["aria-label"]}
      className={["flex gap-2 overflow-x-auto -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className ?? ""].join(" ").trim()}
      style={{ paddingTop: 2, paddingBottom: 4 }}
    >
      {options.map((o) => (
        <button key={o.value} type="button" className="k-filter" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null ? <span style={{ opacity: 0.7, fontWeight: 600 }}>{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
