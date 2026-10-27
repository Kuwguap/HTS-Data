import type { CSSProperties } from "react";

/**
 * Whole-screen placeholder for the role shells' `loading.tsx`: a header line pair,
 * a hero-sized card, 2×2 stat tiles and a grouped list of three rows, all drawn
 * with the `.k-skeleton` shimmer. No text, so nothing has to be translated or
 * guessed; it only has to look like the page that is about to stream in. Render
 * it inside `<Page>` so it shares the 16px gutters and the 12px stack gap.
 */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" aria-label="Loading">
      <header className="k-header" aria-hidden="true">
        <div style={{ minWidth: 0 }}>
          <Line width={150} height={14} />
          <Line width={110} height={26} style={{ marginTop: 8 }} />
        </div>
      </header>

      {/* Hero card: the disc + title/subtitle silhouette, same min-height as .k-hero. */}
      <div className="k-card flex items-center gap-3" style={{ minHeight: 132 }} aria-hidden="true">
        <Line width={64} height={64} radius={32} style={{ flex: "0 0 64px" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Line width="70%" height={20} />
          <Line width="90%" height={13} style={{ marginTop: 10 }} />
          <Line width={120} height={26} radius={13} style={{ marginTop: 12 }} />
        </div>
      </div>

      <div className="k-grid-2" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="k-tile k-tile--zero">
            <Line width="45%" height={28} />
            <Line width="75%" height={12} style={{ marginTop: 6 }} />
          </div>
        ))}
      </div>

      <div aria-hidden="true">
        <div className="k-caption">
          <Line width={90} height={11} />
        </div>
        <div className="k-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="k-row">
              <Line width={32} height={32} radius={16} style={{ flex: "0 0 32px" }} />
              <div className="k-row-main">
                <Line width="55%" height={15} />
                <Line width="80%" height={12} style={{ marginTop: 8 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Line({ width, height, radius, style }: { width: number | string; height: number; radius?: number; style?: CSSProperties }) {
  return <div className="k-skeleton" style={{ width, height, borderRadius: radius ?? Math.min(6, height / 2), ...style }} />;
}
