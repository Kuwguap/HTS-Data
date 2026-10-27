import { describe, expect, it } from "vitest";
import { CHIP_H, chipRect, chipWidthPx, pinRect, placeLabels, type LabelItem } from "@/lib/map/labels";

const at = (x: number, y: number, text = "Hostel main gate"): LabelItem => ({ x, y, text });

describe("chip geometry", () => {
  it("estimates the pill width from the text and keeps the pin box fixed", () => {
    expect(chipWidthPx("KSB (campus)")).toBe(18 + Math.ceil(12 * 6.8));
    expect(pinRect({ x: 100, y: 100 })).toEqual({ x1: 86, y1: 74, x2: 114, y2: 102 });
  });

  it("puts the four sides clear of the pin icon and of each other", () => {
    const p = { x: 100, y: 100 };
    const w = 100;
    const top = chipRect(p, "top", w);
    const bottom = chipRect(p, "bottom", w);
    const right = chipRect(p, "right", w);
    const left = chipRect(p, "left", w);
    const pin = pinRect(p);
    expect(top.y2).toBeLessThanOrEqual(pin.y1);
    expect(bottom.y1).toBeGreaterThanOrEqual(pin.y2);
    expect(right.x1).toBeGreaterThanOrEqual(pin.x2);
    expect(left.x2).toBeLessThanOrEqual(pin.x1);
    // side chips sit between the top and bottom ones
    expect(right.y1).toBeGreaterThanOrEqual(top.y2);
    expect(right.y2).toBeLessThanOrEqual(bottom.y1);
    expect(top.y2 - top.y1).toBe(CHIP_H);
  });
});

describe("placeLabels", () => {
  it("gives far-apart pins the default top chip", () => {
    expect(placeLabels([at(50, 50), at(300, 300)])).toEqual(["top", "top"]);
  });

  it("fans out pins on the same spot: top, bottom, right, left", () => {
    const same = [at(100, 100), at(100, 100), at(100, 100), at(100, 100)];
    expect(placeLabels(same)).toEqual(["top", "bottom", "right", "left"]);
  });

  it("picks the least-covered side when every side collides", () => {
    const five = Array.from({ length: 5 }, () => at(100, 100));
    const dirs = placeLabels(five);
    expect(dirs.slice(0, 4)).toEqual(["top", "bottom", "right", "left"]);
    expect(["top", "bottom", "right", "left"]).toContain(dirs[4]);
  });

  it("does not drop a chip onto the pin 60 px below it", () => {
    // Upper pin first: its "bottom" chip would cover the lower pin's icon and "top" chip,
    // so it must keep "top"; the lower pin's "top" chip is clear of the upper icon.
    const dirs = placeLabels([at(100, 100), at(100, 160)]);
    expect(dirs).toEqual(["top", "top"]);
  });

  it("moves a chip that would hang past the map edge", () => {
    // A pin near the left edge: "left" is out of bounds, "top" is clipped, "right" fits.
    const dirs = placeLabels([at(30, 100), at(30, 100)], { w: 360, h: 220 });
    expect(dirs[0]).toBe("right");
  });

  it("keeps chips off fixed obstacles such as the zoom control", () => {
    // Pin below a 30×60 control at (10, 10): its "top" chip (y 48–70) would clip the control's corner.
    const control = { x1: 10, y1: 10, x2: 40, y2: 70 };
    expect(placeLabels([at(100, 100)], { w: 360, h: 220 })).toEqual(["top"]);
    expect(placeLabels([at(100, 100)], { w: 360, h: 220, obstacles: [control] })).toEqual(["bottom"]);
  });

  it("keeps a fixed direction and still routes others around it", () => {
    const dirs = placeLabels([{ x: 100, y: 100, text: "New pickup point", fixed: "top" }, at(100, 100)]);
    expect(dirs).toEqual(["top", "bottom"]);
  });

  it("returns an empty list for no pins", () => {
    expect(placeLabels([])).toEqual([]);
  });
});
