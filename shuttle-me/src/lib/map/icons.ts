import type * as Leaflet from "leaflet";

// Leaflet is passed in rather than imported: it touches `window` at import time, and
// the admin picker only loads it on demand (await import("leaflet")).

/** 📍 pin; `highlighted` adds the accent glow used for the viewer's own stop / the pin being placed. */
export function pinIcon(L: typeof Leaflet, highlighted = false): Leaflet.DivIcon {
  return L.divIcon({
    className: "k-pin-marker",
    html: `<span aria-hidden="true" style="${highlighted ? "filter:drop-shadow(0 2px 3px rgba(0,0,0,.35)) drop-shadow(0 0 4px var(--accent))" : ""}">📍</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
    tooltipAnchor: [0, -24],
  });
}

/** 🏁 flag for a trip destination (hostel / campus). */
export function flagIcon(L: typeof Leaflet): Leaflet.DivIcon {
  return L.divIcon({
    className: "k-pin-marker",
    html: `<span aria-hidden="true">🏁</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
    tooltipAnchor: [0, -24],
  });
}

/**
 * Leaflet shifts a tooltip by the icon's `tooltipAnchor` ([0, -24] above) whatever its
 * direction, so a "bottom" or "right" chip would still sit level with the "top" one. These
 * offsets undo that per side, so four chips can surround one 28 px pin without touching.
 */
const CHIP_OFFSET: Record<string, Leaflet.PointTuple> = {
  top: [0, 0],
  bottom: [0, 30],
  right: [16, 12],
  left: [-16, 12],
};

/** Options for a permanent name chip (styled by `.k-map-tip` in globals.css). */
export function chipOptions(direction: Leaflet.Direction, variant: "plain" | "mine" | "dest" = "plain"): Leaflet.TooltipOptions {
  const className = variant === "mine" ? "k-map-tip k-map-tip--mine" : variant === "dest" ? "k-map-tip k-map-tip--dest" : "k-map-tip";
  return { permanent: true, direction, offset: CHIP_OFFSET[direction] ?? [0, 0], className, opacity: 1, interactive: false };
}
