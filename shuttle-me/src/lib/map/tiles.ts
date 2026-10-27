/**
 * Basemap tiles shared by LiveTripMap and the admin LocationPicker.
 *
 * CARTO's free basemaps (basemaps.cartocdn.com) became key-gated on 2026-10-27
 * and now return an "API KEY REQUIRED" placeholder for every tile, so the maps
 * use Esri World Street Map instead: no key, CORS "*", real tiles for Kumasi up
 * to z19. Esri has no usable dark basemap at street zoom, so dark mode is a CSS
 * filter on the tile pane (`.k-map-dark .leaflet-tile-pane` in globals.css)
 * rather than a second tile URL.
 *
 * Note the Esri template is {z}/{y}/{x} (y before x), has no subdomains and no
 * retina variant. Override both values with NEXT_PUBLIC_MAP_TILE_URL /
 * NEXT_PUBLIC_MAP_TILE_ATTRIBUTION to switch provider; tiles from another host
 * are network-only unless that host is added to the classifier in public/sw.js
 * (and src/lib/push/sw-logic.ts).
 */

const DEFAULT_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_TILE_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Leaflet tile URL template (inlined at build time from NEXT_PUBLIC_MAP_TILE_URL). */
export const TILE_URL: string = process.env.NEXT_PUBLIC_MAP_TILE_URL || DEFAULT_TILE_URL;

/** Attribution HTML shown in the map corner. */
export const TILE_ATTRIBUTION: string = process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION || DEFAULT_TILE_ATTRIBUTION;

/** Deepest zoom the provider serves for Kumasi. */
export const TILE_MAX_ZOOM = 19;

/** Class toggled on the map container in dark mode; globals.css inverts only the tile pane. */
export const MAP_DARK_CLASS = "k-map-dark";
