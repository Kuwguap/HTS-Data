/** Side of a pin its name chip sits on (a subset of Leaflet's tooltip `direction`). */
export type LabelDirection = "top" | "bottom" | "right" | "left";

/** A pin in container pixels with its chip text; `fixed` pins the chip to one side (the pin being placed). */
export type LabelItem = { x: number; y: number; text: string; fixed?: LabelDirection };

export type Rect = { x1: number; y1: number; x2: number; y2: number };

const ORDER: readonly LabelDirection[] = ["top", "bottom", "right", "left"];

/** Chip box: 12 px/600 system text in a 9 px-padded pill (see .k-map-tip), rounded up a little. */
export const CHIP_H = 22;
export function chipWidthPx(text: string): number {
  return 18 + Math.ceil(text.length * 6.8);
}

/** The 28 px pin icon, anchored 26 px above its point (src/lib/map/icons.ts). */
export function pinRect(p: { x: number; y: number }): Rect {
  return { x1: p.x - 14, y1: p.y - 26, x2: p.x + 14, y2: p.y + 2 };
}

/**
 * Where Leaflet puts the chip for each direction, given the icon's tooltipAnchor
 * ([0, -24]), the per-side offsets in chipOptions() and Leaflet's 6 px direction margins.
 */
export function chipRect(p: { x: number; y: number }, dir: LabelDirection, w: number, h = CHIP_H): Rect {
  switch (dir) {
    case "top":
      return { x1: p.x - w / 2, y1: p.y - 30 - h, x2: p.x + w / 2, y2: p.y - 30 };
    case "bottom":
      return { x1: p.x - w / 2, y1: p.y + 12, x2: p.x + w / 2, y2: p.y + 12 + h };
    case "right":
      return { x1: p.x + 22, y1: p.y - 12 - h / 2, x2: p.x + 22 + w, y2: p.y - 12 + h / 2 };
    case "left":
      return { x1: p.x - 22 - w, y1: p.y - 12 - h / 2, x2: p.x - 22, y2: p.y - 12 + h / 2 };
  }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Area of `r` that falls outside the map container. */
function outsideArea(r: Rect, bounds: { w: number; h: number }): number {
  const inside = overlapArea(r, { x1: 0, y1: 0, x2: bounds.w, y2: bounds.h });
  return (r.x2 - r.x1) * (r.y2 - r.y1) - inside;
}

export type LabelBounds = {
  /** Map container size in pixels. */
  w: number;
  h: number;
  /** Fixed things to keep chips off, in container pixels (e.g. the zoom control). */
  obstacles?: Rect[];
};

/**
 * Greedy label placement, in input order: each chip takes the first of
 * top / bottom / right / left that overlaps nothing (earlier chips, every pin's icon, the
 * map edge, fixed obstacles); when every side collides it takes the least-covered one.
 * Pure pixel maths, so it works at any zoom — callers re-run it after a zoom with fresh
 * container points.
 */
export function placeLabels(items: readonly LabelItem[], bounds?: LabelBounds): LabelDirection[] {
  const pins = items.map(pinRect);
  const placed: Rect[] = [];
  const fixed = bounds?.obstacles ?? [];
  return items.map((item, i) => {
    const w = chipWidthPx(item.text);
    const obstacles = [...placed, ...pins.filter((_, j) => j !== i), ...fixed];
    const score = (dir: LabelDirection): number => {
      const r = chipRect(item, dir, w);
      let s = obstacles.reduce((acc, o) => acc + overlapArea(r, o), 0);
      if (bounds) s += outsideArea(r, bounds);
      return s;
    };
    let dir: LabelDirection = item.fixed ?? "top";
    if (!item.fixed) {
      let best = Infinity;
      for (const d of ORDER) {
        const s = score(d);
        if (s < best) {
          best = s;
          dir = d;
          if (s === 0) break;
        }
      }
    }
    placed.push(chipRect(item, dir, w));
    return dir;
  });
}
