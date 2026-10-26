"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field } from "@/components/ui";

type Preset = { key: string; label: string; from: string; to: string };
type Props = { from: string; to: string; presets: Preset[] };

/** Preset pills (This week / Last week / This month) + a custom from/to picker; navigates with ?from&to. */
export function ReportRange({ from, to, presets }: Props) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(!presets.some((p) => p.from === from && p.to === to));
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Date range" className="flex gap-2 overflow-x-auto -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ paddingTop: 2, paddingBottom: 4 }}>
        {presets.map((p) => (
          <Link key={p.key} href={`/admin/reports?from=${p.from}&to=${p.to}`} className="k-filter" aria-pressed={p.from === from && p.to === to && !customOpen}>
            {p.label}
          </Link>
        ))}
        <button type="button" className="k-filter" aria-pressed={customOpen} onClick={() => setCustomOpen((v) => !v)}>
          Custom
        </button>
      </div>
      {customOpen ? (
        <form
          className="k-card flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (f && t) router.push(`/admin/reports?from=${f}&to=${t}`);
          }}
        >
          <Field label="From" type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} wrapClassName="flex-1" />
          <Field label="To" type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} wrapClassName="flex-1" />
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      ) : null}
    </div>
  );
}
