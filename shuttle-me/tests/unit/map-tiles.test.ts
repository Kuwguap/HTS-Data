import { describe, expect, it } from "vitest";
import { resolveMaxNativeZoom, tileHost } from "@/lib/map/tiles";

const CARTO = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=abc";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";

describe("map tiles: maxNativeZoom", () => {
  it("parses the hostname out of a Leaflet template, including {s} subdomains", () => {
    expect(tileHost(CARTO)).toBe("basemaps.cartocdn.com");
    expect(tileHost("https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png")).toBe("a.basemaps.cartocdn.com");
    expect(tileHost(ESRI)).toBe("server.arcgisonline.com");
    expect(tileHost("not a url")).toBe("");
  });

  it("defaults to 18 for cartocdn.com (z19+ is 403 with a key) and 19 elsewhere", () => {
    expect(resolveMaxNativeZoom(undefined, CARTO)).toBe(18);
    expect(resolveMaxNativeZoom("", CARTO)).toBe(18);
    expect(resolveMaxNativeZoom(undefined, ESRI)).toBe(19);
  });

  it("honours NEXT_PUBLIC_MAP_TILE_MAX_NATIVE_ZOOM when it is a sane integer", () => {
    expect(resolveMaxNativeZoom("17", CARTO)).toBe(17);
    expect(resolveMaxNativeZoom("20", ESRI)).toBe(20);
    expect(resolveMaxNativeZoom("abc", CARTO)).toBe(18);
    expect(resolveMaxNativeZoom("0", CARTO)).toBe(18);
    expect(resolveMaxNativeZoom("99", ESRI)).toBe(19);
  });
});
