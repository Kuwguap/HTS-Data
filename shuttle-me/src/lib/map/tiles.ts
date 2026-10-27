/**
 * Basemap configuration shared by LiveTripMap and the admin LocationPicker.
 *
 * Two kinds of basemap (see src/lib/map/basemap.ts, which picks one at runtime):
 *
 * 1. VECTOR (default): a MapLibre GL style rendered inside the Leaflet map.
 *    NEXT_PUBLIC_MAP_STYLE_URL defaults to OpenFreeMap "bright" — OpenStreetMap data
 *    with the names of real places (halls, hostels, churches, shops, roads) that the
 *    raster providers below leave out around Kumasi, crisp on retina screens, no key.
 *    NEXT_PUBLIC_MAP_STYLE_URL_DARK is an optional dark style; without one dark mode
 *    is the CSS filter. Set NEXT_PUBLIC_MAP_STYLE_URL to "" (or "off") to force raster.
 *
 * 2. RASTER (fallback when WebGL is unavailable or the style is switched off):
 * Production sets NEXT_PUBLIC_MAP_TILE_URL to the keyed CARTO Voyager template
 * (basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=…) and
 * NEXT_PUBLIC_MAP_TILE_URL_DARK to the dark_all equivalent; the key lives only in
 * the environment, never here. With a dark URL both maps create the tile LAYER
 * for the current colour scheme and swap it when `prefers-color-scheme` changes.
 *
 * Without any env the fallback is Esri World Street Map: no key, CORS "*", real
 * tiles for Kumasi up to z19, but no dark basemap — so dark mode becomes a CSS
 * filter on the tile pane (`.k-map-dark .leaflet-tile-pane` in globals.css).
 * The Esri template is {z}/{y}/{x} (y before x), has no subdomains and no retina
 * variant. Leaflet's {r} placeholder handles retina ("@2x" on 2× screens), so the
 * layers are created with detectRetina: false.
 *
 * Tiles from another host are network-only unless that host is added to the
 * classifier in public/sw.js (and src/lib/push/sw-logic.ts); cartocdn.com and
 * server.arcgisonline.com are already there.
 */
import type { TileLayerOptions } from "leaflet";

const DEFAULT_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_TILE_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Light-scheme Leaflet tile URL template (inlined at build time from NEXT_PUBLIC_MAP_TILE_URL). */
export const TILE_URL: string = process.env.NEXT_PUBLIC_MAP_TILE_URL || DEFAULT_TILE_URL;

/** Dark-scheme template (NEXT_PUBLIC_MAP_TILE_URL_DARK), or null → dark mode is the CSS filter. */
export const TILE_URL_DARK: string | null = process.env.NEXT_PUBLIC_MAP_TILE_URL_DARK || null;

/** True when the provider has real dark tiles: swap layers instead of filtering. */
export const HAS_DARK_TILES: boolean = TILE_URL_DARK !== null;

/** Attribution HTML shown in the map corner. */
export const TILE_ATTRIBUTION: string = process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION || DEFAULT_TILE_ATTRIBUTION;

/** Deepest zoom the map allows; past maxNativeZoom Leaflet upscales the last native level. */
export const TILE_MAX_ZOOM = 19;

/**
 * Deepest zoom the provider actually serves (NEXT_PUBLIC_MAP_TILE_MAX_NATIVE_ZOOM).
 * Default 18 for cartocdn.com (z19+ answers 403 with a key), otherwise 19.
 */
export const TILE_MAX_NATIVE_ZOOM: number = resolveMaxNativeZoom(process.env.NEXT_PUBLIC_MAP_TILE_MAX_NATIVE_ZOOM, TILE_URL);

/** Class toggled on the map container in dark mode when there are no dark tiles; globals.css inverts only the tile pane. */
export const MAP_DARK_CLASS = "k-map-dark";

/** OpenFreeMap "bright": OSM-derived OpenMapTiles with named points of interest from z15, no key, CORS "*". */
const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/bright";
const DEFAULT_STYLE_ATTRIBUTION =
  '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Exported for tests: unset → the default style; "", "off", "none" or "0" → no vector basemap (raster only); anything else verbatim. */
export function resolveStyleUrl(envValue: string | undefined): string | null {
  if (envValue === undefined) return DEFAULT_STYLE_URL;
  const v = envValue.trim();
  if (v === "" || /^(off|none|0|false)$/i.test(v)) return null;
  return v;
}

/** Light-scheme MapLibre style URL (NEXT_PUBLIC_MAP_STYLE_URL), or null when the vector basemap is switched off. */
export const STYLE_URL: string | null = resolveStyleUrl(process.env.NEXT_PUBLIC_MAP_STYLE_URL);

/** Dark-scheme style (NEXT_PUBLIC_MAP_STYLE_URL_DARK), or null → dark mode is the CSS filter on the GL canvas. */
export const STYLE_URL_DARK: string | null = process.env.NEXT_PUBLIC_MAP_STYLE_URL_DARK || null;

/** True when the provider has a real dark style: swap styles instead of filtering. */
export const HAS_DARK_STYLE: boolean = STYLE_URL_DARK !== null;

/** Attribution HTML for the vector basemap (NEXT_PUBLIC_MAP_STYLE_ATTRIBUTION). */
export const STYLE_ATTRIBUTION: string = process.env.NEXT_PUBLIC_MAP_STYLE_ATTRIBUTION || DEFAULT_STYLE_ATTRIBUTION;

/** Style URL for a colour scheme (falls back to the light one when no dark style is configured). */
export function styleUrlFor(dark: boolean): string | null {
  return dark && STYLE_URL_DARK ? STYLE_URL_DARK : STYLE_URL;
}

/**
 * Same-origin path of MapLibre's web worker for the installed version. maplibre-gl
 * looks for "./maplibre-gl-worker.mjs" next to its own module URL, which inside a
 * Next.js chunk does not exist; scripts/vendor-maplibre-worker.mjs copies the file
 * into public/vendor/ and basemap.ts points MapLibre here (setWorkerUrl).
 */
export function maplibreWorkerPath(version: string): string {
  return `/vendor/maplibre-gl-worker-${version}.mjs`;
}

/** Hostname of a Leaflet URL template ("{z}" placeholders are harmless to the URL parser), "" when unparsable. */
export function tileHost(template: string): string {
  try {
    return new URL(template.replace(/\{s\}/g, "a")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Exported for tests: the env override when it is an integer 1..22, else the per-host default. */
export function resolveMaxNativeZoom(envValue: string | undefined, lightUrl: string): number {
  const n = envValue ? Number.parseInt(envValue, 10) : Number.NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 22) return n;
  return tileHost(lightUrl).endsWith("cartocdn.com") ? 18 : 19;
}

/** Template for a colour scheme (falls back to the light one when no dark URL is configured). */
export function tileUrlFor(dark: boolean): string {
  return dark && TILE_URL_DARK ? TILE_URL_DARK : TILE_URL;
}

/**
 * Options for every L.tileLayer in the app. crossOrigin: tiles come back as real
 * (non-opaque) responses so sw.js can cache them. detectRetina stays off: {r}
 * in the template already picks "@2x" on retina screens.
 */
export const TILE_LAYER_OPTIONS: TileLayerOptions = {
  attribution: TILE_ATTRIBUTION,
  maxZoom: TILE_MAX_ZOOM,
  maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
  detectRetina: false,
  crossOrigin: true,
};
