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
 * Fallback: the raster tile layer (keyed CARTO, else Esri) when WebGL2 is unavailable
 * (MapLibre ≥ 5 needs it), the style is switched off, the MapLibre chunk fails to
 * load, or the style / tilejson / worker fails to load (MapLibre only reports that
 * as an "error" event, or hangs — see STYLE_LOAD_TIMEOUT_MS). Dark mode: a real dark
 * style/tile set when configured, otherwise the CSS filter on the tile pane
 * (`.k-map-dark .leaflet-tile-pane` in globals.css — the GL canvas lives in that pane).
 *
 * Cost, first time only (then served by the HTTP and service-worker caches): the
 * MapLibre chunk (~300 KB gzipped) + the vendored worker (~150 KB gzipped), imported on
 * demand when a map is created, plus the style's sprite, glyphs and vector tiles.
 * preloadBasemap() starts those downloads while the map component itself loads.
 */
import type * as Leaflet from "leaflet";
import type { Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { HAS_DARK_STYLE, HAS_DARK_TILES, MAP_DARK_CLASS, STYLE_ATTRIBUTION, STYLE_URL, TILE_LAYER_OPTIONS, maplibreWorkerPath, styleUrlFor, tileUrlFor } from "./tiles";

export type Basemap = {
  readonly kind: "vector" | "raster";
  /** Follow the colour scheme: swap the style / tile set when the provider has a dark one, else toggle the CSS filter. */
  setDark(dark: boolean): void;
  /** Detach from the map (call before map.remove()). */
  remove(): void;
};

/** A vector style that has not loaded by then counts as failed: a hanging connection never fires "error". */
export const STYLE_LOAD_TIMEOUT_MS = 20_000;

/** WebGL2 available in this browser — what MapLibre GL ≥ 5 actually needs. False during SSR and on WebGL1-only GPUs. */
export function webglSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

/** True when the vector basemap will be attempted (style configured + WebGL2). */
export function vectorBasemapAvailable(): boolean {
  return STYLE_URL !== null && webglSupported();
}

/**
 * Warm the vector stack (MapLibre chunk, adapter, the worker file) before a map mounts,
 * so the first map does not pay for them one after the other. No-op on the raster path.
 */
export function preloadBasemap(): void {
  if (!vectorBasemapAvailable()) return;
  void Promise.all([import("@maplibre/maplibre-gl-leaflet"), import("maplibre-gl")])
    .then(([, maplibregl]) => {
      // Same-origin, immutable: lands in the HTTP cache (and the service worker's) for new Worker().
      const init: RequestInit & { priority?: "low" } = { priority: "low" };
      return fetch(maplibreWorkerPath(maplibregl.getVersion()), init).catch(() => undefined);
    })
    .catch(() => undefined);
}

const NOOP: Basemap = { kind: "raster", setDark: () => undefined, remove: () => undefined };

type GuardedLayer = Leaflet.MaplibreGL & {
  _map: Leaflet.Map | null;
  _glMap: MaplibreMap | null;
  _container?: HTMLElement;
  _resizeContainer(): void;
  _zoomEnd(): void;
};
type GuardedLayerClass = new (options: Leaflet.LeafletMaplibreGLOptions) => Leaflet.MaplibreGL;
let guardedClass: GuardedLayerClass | null = null;

/**
 * The adapter's layer, hardened for two real cases:
 * - MapLibre's constructor throws inside onAdd (no WebGL2, GPU blocklist): Leaflet has
 *   already registered the layer and bound its map events, so every later pan / zoom /
 *   removal would dereference the missing GL map. Every handler now checks it exists.
 * - The adapter defers work to an animation frame (_transitionEnd, also run on
 *   resize); when the layer was removed meanwhile the frame must do nothing.
 */
function guardedLayerClass(L: typeof Leaflet, MaplibreGL: typeof Leaflet.MaplibreGL): GuardedLayerClass {
  if (guardedClass) return guardedClass;
  const proto = MaplibreGL.prototype as unknown as Record<string, ((this: GuardedLayer, ...args: unknown[]) => unknown) | undefined>;
  const original = (name: string) => {
    const fn = proto[name];
    if (!fn) throw new Error(`maplibre-gl-leaflet: missing ${name}`);
    return fn;
  };
  const alive = (self: GuardedLayer) => Boolean(self._map && self._glMap);
  const guard = (name: string) => {
    const fn = original(name);
    return function (this: GuardedLayer, ...args: unknown[]) {
      if (alive(this)) fn.call(this, ...args);
    };
  };
  const onRemove = original("onRemove");
  guardedClass = (MaplibreGL as unknown as typeof Leaflet.Class).extend({
    onRemove(this: GuardedLayer, map: Leaflet.Map) {
      if (!this._glMap) {
        // Half-added layer (constructor threw): only its empty container exists.
        this._container?.remove();
        return;
      }
      onRemove.call(this, map);
    },
    _update: guard("_update"),
    _pinchZoom: guard("_pinchZoom"),
    _animateZoom: guard("_animateZoom"),
    _zoomStart: guard("_zoomStart"),
    _zoomEnd: guard("_zoomEnd"),
    _transitionEnd(this: GuardedLayer) {
      L.Util.requestAnimFrame(function (this: GuardedLayer) {
        if (!alive(this)) return;
        const map = this._map!;
        const gl = this._glMap!;
        const zoom = map.getZoom();
        const center = map.getCenter();
        const offset = map.latLngToContainerPoint(map.getBounds().getNorthWest());
        this._resizeContainer();
        L.DomUtil.setTransform((gl as unknown as { _actualCanvas: HTMLElement })._actualCanvas, offset, 1);
        gl.once("moveend", () => this._zoomEnd());
        gl.jumpTo({ center: [center.lng, center.lat], zoom: zoom - 1 });
      }, this);
    },
  }) as unknown as GuardedLayerClass;
  return guardedClass;
}

/**
 * Add the basemap to `map` for the given colour scheme. `isCancelled` lets the caller
 * abandon the (async) vector path when its component unmounted meanwhile; the
 * returned basemap is then a no-op that touched nothing.
 */
export async function createBasemap(L: typeof Leaflet, map: Leaflet.Map, dark: boolean, isCancelled: () => boolean = () => false): Promise<Basemap> {
  const el = map.getContainer();
  const filter = (hasDark: boolean) => (d: boolean) => el.classList.toggle(MAP_DARK_CLASS, d && !hasDark);

  const raster = (d: boolean): Basemap => {
    let tiles = L.tileLayer(tileUrlFor(d && HAS_DARK_TILES), TILE_LAYER_OPTIONS).addTo(map);
    const applyFilter = filter(HAS_DARK_TILES);
    applyFilter(d);
    return {
      kind: "raster",
      setDark(next) {
        if (HAS_DARK_TILES) {
          const url = tileUrlFor(next);
          const current = tiles as Leaflet.TileLayer & { _url?: string };
          if (current._url !== url) {
            tiles.remove();
            tiles = L.tileLayer(url, TILE_LAYER_OPTIONS).addTo(map);
          }
        } else applyFilter(next);
      },
      remove() {
        tiles.remove();
        el.classList.remove(MAP_DARK_CLASS);
      },
    };
  };

  if (!vectorBasemapAvailable()) return raster(dark);

  let layer: Leaflet.MaplibreGL;
  try {
    const [{ MaplibreGL }, maplibregl] = await Promise.all([import("@maplibre/maplibre-gl-leaflet"), import("maplibre-gl")]);
    if (isCancelled()) return NOOP;
    // The worker that decodes vector tiles is served from /public (see tiles.ts); must be set before the first map.
    const workerPath = maplibreWorkerPath(maplibregl.getVersion());
    if (maplibregl.getWorkerUrl() !== workerPath) maplibregl.setWorkerUrl(workerPath);
    const style = styleUrlFor(dark);
    if (!style) return raster(dark);
    const Guarded = guardedLayerClass(L, MaplibreGL);
    layer = new Guarded({ style, attributionControl: { customAttribution: STYLE_ATTRIBUTION }, fadeDuration: 100 });
    try {
      layer.addTo(map);
    } catch (err) {
      // Atomic: a constructor failure (no WebGL2 after all, GPU blocklist…) leaves nothing behind.
      layer.remove();
      throw err;
    }
  } catch (err) {
    // e.g. the chunk failed to download on a flaky connection: the raster layer still works.
    console.warn("Vector basemap unavailable, using raster tiles", err);
    if (isCancelled()) return NOOP;
    return raster(dark);
  }

  // Leaflet owns every gesture; the GL canvas is decoration for assistive tech.
  const canvas = layer.getCanvas();
  canvas.setAttribute("aria-hidden", "true");
  canvas.removeAttribute("role");
  canvas.removeAttribute("aria-label");

  const applyFilter = filter(HAS_DARK_STYLE);
  applyFilter(dark);
  const vector: Basemap = {
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

  // Until the style has rendered once, an "error" (style, tilejson, sprite, glyphs or the
  // worker failing to load) or a long silence means no map at all: swap in the raster layer.
  let current = vector;
  let currentDark = dark;
  let settled = false;
  const gl = layer.getMaplibreMap();
  const onError = (e: { error?: unknown }) => fallBack(e.error ?? e);
  const settle = () => {
    settled = true;
    window.clearTimeout(timer);
    gl.off("error", onError);
  };
  const fallBack = (why: unknown) => {
    if (settled) return;
    settle();
    console.warn("Vector basemap failed to load, using raster tiles", why);
    current.remove();
    if (isCancelled()) return;
    current = raster(currentDark);
  };
  const timer = window.setTimeout(() => fallBack(new Error(`style did not load within ${STYLE_LOAD_TIMEOUT_MS / 1000} s`)), STYLE_LOAD_TIMEOUT_MS);
  gl.once("load", settle);
  gl.on("error", onError);

  return {
    get kind() {
      return current.kind;
    },
    setDark(d) {
      currentDark = d;
      current.setDark(d);
    },
    remove() {
      if (!settled) settle();
      current.remove();
    },
  };
}
