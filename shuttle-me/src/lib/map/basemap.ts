"use client";

/**
 * The basemap under every Leaflet map in the app (LiveTripMap, LocationPicker).
 *
 * Preferred: a MapLibre GL vector style (OpenFreeMap "bright" by default, see tiles.ts)
 * hosted inside the Leaflet map by @maplibre/maplibre-gl-leaflet — Leaflet keeps
 * owning panning, zooming, markers, tooltips and polylines, the GL canvas only draws
 * the map itself. That style labels the real places (halls, hostels, churches, shops,
 * roads) the raster providers leave out around Kumasi, and text stays crisp on retina.
 *
 * Fallback: the raster tile layer (keyed CARTO, else Esri) when WebGL is unavailable,
 * the style is switched off, or MapLibre fails to load. Dark mode: a real dark
 * style/tile set when configured, otherwise the CSS filter on the tile pane
 * (`.k-map-dark .leaflet-tile-pane` in globals.css — the GL canvas lives in that pane).
 *
 * MapLibre (~250 KB gzipped) is imported on demand, only when a map is created.
 */
import type * as Leaflet from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";
import { HAS_DARK_STYLE, HAS_DARK_TILES, MAP_DARK_CLASS, STYLE_ATTRIBUTION, STYLE_URL, TILE_LAYER_OPTIONS, maplibreWorkerPath, styleUrlFor, tileUrlFor } from "./tiles";

export type Basemap = {
  kind: "vector" | "raster";
  /** Follow the colour scheme: swap the style / tile set when the provider has a dark one, else toggle the CSS filter. */
  setDark(dark: boolean): void;
  /** Detach from the map (call before map.remove()). */
  remove(): void;
};

/** WebGL (1 or 2) available in this browser — false during SSR and in the rare browser without it. */
export function webglSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** True when the vector basemap will be attempted (style configured + WebGL). */
export function vectorBasemapAvailable(): boolean {
  return STYLE_URL !== null && webglSupported();
}

const NOOP: Basemap = { kind: "raster", setDark: () => undefined, remove: () => undefined };

/**
 * Add the basemap to `map` for the given colour scheme. `isCancelled` lets the caller
 * abandon the (async) vector path when its component unmounted meanwhile; the
 * returned basemap is then a no-op that touched nothing.
 */
export async function createBasemap(L: typeof Leaflet, map: Leaflet.Map, dark: boolean, isCancelled: () => boolean = () => false): Promise<Basemap> {
  const el = map.getContainer();
  const filter = (hasDark: boolean) => (d: boolean) => el.classList.toggle(MAP_DARK_CLASS, d && !hasDark);

  if (vectorBasemapAvailable()) {
    try {
      const [{ maplibreGL }, maplibregl] = await Promise.all([import("@maplibre/maplibre-gl-leaflet"), import("maplibre-gl")]);
      if (isCancelled()) return NOOP;
      // The worker that decodes vector tiles is served from /public (see tiles.ts); must be set before the first map.
      const workerPath = maplibreWorkerPath(maplibregl.getVersion());
      if (maplibregl.getWorkerUrl() !== workerPath) maplibregl.setWorkerUrl(workerPath);
      const style = styleUrlFor(dark);
      if (style) {
        const layer = maplibreGL({ style, attributionControl: { customAttribution: STYLE_ATTRIBUTION }, fadeDuration: 100 }).addTo(map);
        const applyFilter = filter(HAS_DARK_STYLE);
        applyFilter(dark);
        return {
          kind: "vector",
          setDark(d) {
            if (HAS_DARK_STYLE) {
              const next = styleUrlFor(d);
              const gl = layer.getMaplibreMap();
              if (next && gl) gl.setStyle(next);
            } else applyFilter(d);
          },
          remove() {
            layer.remove();
            el.classList.remove(MAP_DARK_CLASS);
          },
        };
      }
    } catch (err) {
      // e.g. the chunk failed to download on a flaky connection: the raster layer below still works.
      console.warn("Vector basemap unavailable, using raster tiles", err);
      if (isCancelled()) return NOOP;
    }
  }

  let tiles = L.tileLayer(tileUrlFor(dark && HAS_DARK_TILES), TILE_LAYER_OPTIONS).addTo(map);
  const applyFilter = filter(HAS_DARK_TILES);
  applyFilter(dark);
  return {
    kind: "raster",
    setDark(d) {
      if (HAS_DARK_TILES) {
        const url = tileUrlFor(d);
        const current = tiles as Leaflet.TileLayer & { _url?: string };
        if (current._url !== url) {
          tiles.remove();
          tiles = L.tileLayer(url, TILE_LAYER_OPTIONS).addTo(map);
        }
      } else applyFilter(d);
    },
    remove() {
      tiles.remove();
      el.classList.remove(MAP_DARK_CLASS);
    },
  };
}
