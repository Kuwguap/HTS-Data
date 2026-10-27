"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { chipOptions, flagIcon, pinIcon } from "@/lib/map/icons";
import { placeLabels, type LabelItem } from "@/lib/map/labels";
import { HAS_DARK_TILES, MAP_DARK_CLASS, TILE_LAYER_OPTIONS, tileUrlFor } from "@/lib/map/tiles";

/** A saved place drawn for context (not editable here): a pickup point 📍 or a hostel/campus destination 🏁. */
export type PickerPlace = { id?: string; name: string; lat: number; lng: number; kind?: "pickup" | "destination" };

export type LocationPickerProps = {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  height?: number;
  /** Name chip on the pin being placed; updated live as the admin types. */
  label?: string;
  /** Other saved places, each with its name chip, so the admin can see where this one sits. */
  places?: PickerPlace[];
};

/** KNUST / Kharis Courts area, Kumasi. */
const DEFAULT_CENTER: [number, number] = [6.6745, -1.5716];
const DEFAULT_LABEL = "New pickup point";
const NO_PLACES: PickerPlace[] = [];

/**
 * Small Leaflet map (street tiles; dark layer or CSS-darkened, see src/lib/map/tiles.ts) to place a pickup point: tap to move the pin,
 * or use the phone's GPS. Every other saved place is drawn with its name, like on the
 * live map. Loaded client-side only — import it with next/dynamic ({ ssr: false }).
 */
export default function LocationPicker({ lat, lng, onChange, height = 220, label, places = NO_PLACES }: LocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markerRef = useRef<Leaflet.Marker | null>(null);
  const placesRef = useRef<Leaflet.LayerGroup | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const tileRef = useRef<Leaflet.TileLayer | null>(null);
  const onChangeRef = useRef(onChange);
  const labelRef = useRef(label);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every zoom so the chips are re-spread for the new scale.
  const [zoomTick, setZoomTick] = useState(0);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const chipText = label?.trim() || DEFAULT_LABEL;

  useEffect(() => {
    let cancelled = false;
    let unsubScheme: (() => void) | null = null;
    let fitTimer: number | null = null;
    (async () => {
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;
      const el = containerRef.current;
      const hasPin = lat != null && lng != null;
      const start: [number, number] = hasPin ? [lat, lng] : DEFAULT_CENTER;
      const map = L.map(el, { center: start, zoom: 15, zoomControl: true, attributionControl: true });
      // Same scheme handling as LiveTripMap: swap the tile layer when the provider has dark
      // tiles, otherwise one layer + the CSS filter on the tile pane (globals.css).
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      tileRef.current = L.tileLayer(tileUrlFor(HAS_DARK_TILES && mq.matches), TILE_LAYER_OPTIONS).addTo(map);
      const applyScheme = () => {
        if (HAS_DARK_TILES) {
          const url = tileUrlFor(mq.matches);
          const current = tileRef.current as (Leaflet.TileLayer & { _url?: string }) | null;
          if (current && current._url !== url) {
            current.remove();
            tileRef.current = L.tileLayer(url, TILE_LAYER_OPTIONS).addTo(map);
          }
        } else {
          el.classList.toggle(MAP_DARK_CLASS, mq.matches);
        }
      };
      applyScheme();
      mq.addEventListener("change", applyScheme);
      // Leaflet's Map.remove() fires "unload" (not "remove"), so detach in the effect cleanup below.
      unsubScheme = () => mq.removeEventListener("change", applyScheme);
      placesRef.current = L.layerGroup().addTo(map);
      if (hasPin) markerRef.current = makePin(L, [lat, lng], labelRef.current).addTo(map);
      map.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const next: [number, number] = [Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))];
        onChangeRef.current(next[0], next[1]);
      });
      map.on("zoomend", () => setZoomTick((n) => n + 1));
      mapRef.current = map;
      drawPlaces(L, map, placesRef.current, places, hasPin ? { lat, lng } : null);
      // Leaflet measures the container on creation; fix up after layout settles, then open
      // the view wide enough to show every saved place together with the pin.
      const everything: Leaflet.LatLngTuple[] = [...places.map((p): Leaflet.LatLngTuple => [p.lat, p.lng]), ...(hasPin ? [start] : [])];
      fitTimer = window.setTimeout(() => {
        map.invalidateSize();
        if (everything.length > 1) map.fitBounds(L.latLngBounds(everything), { padding: [28, 28], maxZoom: 17 });
      }, 50);
    })().catch((err: unknown) => setError(err instanceof Error ? err.message : "Map could not load"));
    return () => {
      cancelled = true;
      if (fitTimer != null) window.clearTimeout(fitTimer);
      unsubScheme?.();
      unsubScheme = null;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      placesRef.current = null;
      tileRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; prop changes are applied by the effects below
  }, []);

  // Keep the pin in step with the lat/lng fields.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const pos: [number, number] = [lat, lng];
    if (markerRef.current) markerRef.current.setLatLng(pos);
    else markerRef.current = makePin(L, pos, labelRef.current).addTo(map);
    if (!map.getBounds().contains(pos)) map.panTo(pos);
  }, [lat, lng]);

  // The pin's chip follows the Name field.
  useEffect(() => {
    labelRef.current = chipText;
    markerRef.current?.setTooltipContent(chipText);
  }, [chipText]);

  // Other places are redrawn when they change, when the pin moves (their chips fan out around it) and after a zoom.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const group = placesRef.current;
    if (!L || !map || !group) return;
    drawPlaces(L, map, group, places, lat != null && lng != null ? { lat, lng } : null);
  }, [places, lat, lng, zoomTick]);

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setError("Location is not available on this device.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next: [number, number] = [Number(pos.coords.latitude.toFixed(6)), Number(pos.coords.longitude.toFixed(6))];
        onChangeRef.current(next[0], next[1]);
        mapRef.current?.setView(next, 17);
        setLocating(false);
      },
      () => {
        setError("Could not get your location. Allow location access and try again.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div ref={containerRef} style={{ height, borderRadius: 14, overflow: "hidden", background: "var(--surface-3)" }} aria-label="Map: tap to place the pickup point" />
      <div className="flex items-center justify-between gap-2">
        <span className="k-help" style={{ margin: 0 }}>
          Tap the map to move the pin.
        </span>
        <Button variant="secondary" size="sm" pill loading={locating} onClick={useMyLocation}>
          📍 Use my location
        </Button>
      </div>
      {error ? <div className="k-error">{error}</div> : null}
    </div>
  );
}

/** The editable pin: glowing 📍 with the blue name chip, above every context pin. */
function makePin(L: typeof Leaflet, pos: [number, number], label: string | undefined): Leaflet.Marker {
  const m = L.marker(pos, { icon: pinIcon(L, true), zIndexOffset: 500, keyboard: false });
  m.bindTooltip(label?.trim() || DEFAULT_LABEL, chipOptions("top", "mine"));
  return m;
}

/**
 * Context pins with their names. They are not interactive, so a tap on one still lands
 * on the map and moves the editable pin. Chip sides are chosen in screen space at the
 * current zoom (placeLabels), with the editable pin fixed to "top" so the others route
 * around it and nothing hangs past the map edge.
 */
function drawPlaces(L: typeof Leaflet, map: Leaflet.Map, group: Leaflet.LayerGroup, places: PickerPlace[], pin: { lat: number; lng: number } | null): void {
  group.clearLayers();
  if (places.length === 0) return;
  const toItem = (p: { lat: number; lng: number }, text: string, fixed?: "top"): LabelItem => {
    const c = map.latLngToContainerPoint([p.lat, p.lng]);
    return { x: c.x, y: c.y, text, fixed };
  };
  const items = [...(pin ? [toItem(pin, "", "top")] : []), ...places.map((p) => toItem(p, p.name))];
  const size = map.getSize();
  // Keep chips from sliding under the zoom buttons (top-left corner).
  const mapBox = map.getContainer().getBoundingClientRect();
  const zoomBox = map.zoomControl?.getContainer()?.getBoundingClientRect();
  const obstacles = zoomBox ? [{ x1: zoomBox.left - mapBox.left, y1: zoomBox.top - mapBox.top, x2: zoomBox.right - mapBox.left, y2: zoomBox.bottom - mapBox.top }] : [];
  const dirs = placeLabels(items, { w: size.x, h: size.y, obstacles });
  const offset = pin ? 1 : 0;
  places.forEach((p, i) => {
    const dest = p.kind === "destination";
    const m = L.marker([p.lat, p.lng], { icon: dest ? flagIcon(L) : pinIcon(L), interactive: false, keyboard: false, zIndexOffset: dest ? 200 : 0 });
    m.bindTooltip(p.name, chipOptions(dirs[i + offset] ?? "top", dest ? "dest" : "plain"));
    group.addLayer(m);
  });
}
