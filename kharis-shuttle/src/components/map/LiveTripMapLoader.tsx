"use client";

import dynamic from "next/dynamic";
import type { LiveTripMapProps } from "./LiveTripMap";

function MapSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div
      className="k-skeleton"
      style={{ height: compact ? 220 : "max(320px, calc(100dvh - 300px))", borderRadius: "var(--radius-card)" }}
      aria-busy="true"
      aria-label="Loading map"
    />
  );
}

const LiveTripMap = dynamic(() => import("./LiveTripMap"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

/**
 * Client-only wrapper around LiveTripMap (Leaflet needs `window`). Same props.
 * Use this from Server Components and pages; never import LiveTripMap directly.
 */
export default function LiveTripMapLoader(props: LiveTripMapProps) {
  return <LiveTripMap {...props} />;
}

export type { LiveTripMapProps };
