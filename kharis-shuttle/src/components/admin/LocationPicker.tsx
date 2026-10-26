"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";

export type LocationPickerProps = {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  height?: number;
};

/** KNUST / Kharis Courts area, Kumasi. */
const DEFAULT_CENTER: [number, number] = [6.6745, -1.5716];
const TILE = {
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png",
};
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function pinIcon(L: typeof Leaflet) {
  return L.divIcon({
    className: "",
    html: '<div style="font-size:32px;line-height:1;transform:translate(-50%,-100%);filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))">📍</div>',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/**
 * Small Leaflet map (Carto tiles) to place a pickup point: tap to move the pin,
 * or use the phone's GPS. Loaded client-side only — import it with next/dynamic
 * ({ ssr: false }).
 */
export default function LocationPicker({ lat, lng, onChange, height = 220 }: LocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markerRef = useRef<Leaflet.Marker | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const onChangeRef = useRef(onChange);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;
      const dark = document.documentElement.dataset.theme === "dark";
      const start: [number, number] = lat != null && lng != null ? [lat, lng] : DEFAULT_CENTER;
      const map = L.map(containerRef.current, { center: start, zoom: 15, zoomControl: true, attributionControl: true });
      L.tileLayer(dark ? TILE.dark : TILE.light, { attribution: ATTRIBUTION, subdomains: "abcd", maxZoom: 19 }).addTo(map);
      if (lat != null && lng != null) markerRef.current = L.marker(start, { icon: pinIcon(L) }).addTo(map);
      map.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const next: [number, number] = [Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))];
        onChangeRef.current(next[0], next[1]);
      });
      mapRef.current = map;
      window.setTimeout(() => map.invalidateSize(), 50);
    })().catch((err: unknown) => setError(err instanceof Error ? err.message : "Map could not load"));
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; prop changes are applied by the effect below
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
    else markerRef.current = L.marker(pos, { icon: pinIcon(L) }).addTo(map);
    if (!map.getBounds().contains(pos)) map.panTo(pos);
  }, [lat, lng]);

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
