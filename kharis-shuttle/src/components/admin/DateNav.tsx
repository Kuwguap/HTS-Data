"use client";

import { useRouter } from "next/navigation";
import { addDays, formatDayLabel, localDateString } from "@/lib/time";

type Props = { date: string; today: string; timeZone: string; basePath: string };

/** "‹ Prev · [date] · Next ›" strip for day-by-day pages; navigates with ?date=. */
export function DateNav({ date, today, timeZone, basePath }: Props) {
  const router = useRouter();
  const go = (d: string) => router.push(`${basePath}?date=${d}`);
  const noon = new Date(`${date}T12:00:00Z`);
  const prev = localDateString(addDays(noon, -1), "UTC");
  const next = localDateString(addDays(noon, 1), "UTC");
  const label = formatDayLabel(noon, new Date(`${today}T12:00:00Z`), "UTC");
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="k-filter" onClick={() => go(prev)} aria-label="Previous day" style={{ padding: "0 14px" }}>
        ‹
      </button>
      <label className="k-filter" style={{ flex: 1, justifyContent: "center", gap: 8, cursor: "pointer" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && go(e.target.value)}
          aria-label="Pick a date"
          style={{ fontSize: 16, background: "transparent", color: "var(--hint)", maxWidth: 140 }}
        />
      </label>
      <button type="button" className="k-filter" onClick={() => go(next)} aria-label="Next day" style={{ padding: "0 14px" }}>
        ›
      </button>
      {date !== today ? (
        <button type="button" className="k-filter" onClick={() => go(today)} style={{ padding: "0 14px" }}>
          Today
        </button>
      ) : null}
      <span className="sr-only">{timeZone}</span>
    </div>
  );
}
