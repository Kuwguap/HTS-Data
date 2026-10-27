/**
 * Basemap tiles shared by LiveTripMap and the admin LocationPicker.
 *
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
