"use client";

// Only ever loaded through LiveTripMapLoader (next/dynamic, ssr: false): Leaflet touches `window` at import time.
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PickupLocation, Trip } from "@/lib/db.types";
import { estimateEtaSeconds, formatDistance, formatEta, haversineM } from "@/lib/geo";
import { useTripLocation } from "@/hooks/useTripLocation";
import { HAS_DARK_TILES, MAP_DARK_CLASS, TILE_LAYER_OPTIONS, tileUrlFor } from "@/lib/map/tiles";

export type LiveTripMapProps = {
  tripId: string;
  initialTrip: Trip;
  pickupLocations: PickupLocation[];
  /** The viewer's own pickup point (highlighted with a "You" tooltip, used for distance/ETA). */
  myPickupLocationId?: string | null;
  settings: { timezone: string; location_stale_seconds: number; hostel_name: string; campus_name: string };
  /** Small 220px preview (driver tracking screen) instead of a tall map. */
  compact?: boolean;
};

// Kumasi (KNUST) — only used before any pin or fix is known.
const FALLBACK_CENTER: L.LatLngExpression = [6.6745, -1.5716];

/** "just now", "45s ago", "3 min ago" from a seconds count (pure; the hook ticks the number). */
function agoFromSeconds(s: number): string {
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function accentColor(): string {
  if (typeof window === "undefined") return "#0070dd";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return v || "#0070dd";
}

const STALE_CLASS = "k-bus-marker--stale";

/** Created once; heading and staleness are then applied in place (see updateBusMarker) so Leaflet never rebuilds the DOM node. */
function busIcon(heading: number | null, stale: boolean): L.DivIcon {
  return L.divIcon({
    className: `k-bus-marker${stale ? ` ${STALE_CLASS}` : ""}`,
    html: `<span class="k-bus-marker__emoji" style="transform:rotate(${headingDeg(heading)}deg)" aria-hidden="true">🚌</span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function headingDeg(heading: number | null): number {
  return heading == null ? 0 : Math.round(heading);
}

/** Rotate the emoji and toggle the stale look without replacing the icon (keeps the CSS transition and the compositor layer). */
function updateBusMarker(marker: L.Marker, heading: number | null, stale: boolean): void {
  const el = marker.getElement();
  if (!el) return;
  el.classList.toggle(STALE_CLASS, stale);
  const emoji = el.querySelector<HTMLElement>(".k-bus-marker__emoji");
  if (emoji) emoji.style.transform = `rotate(${headingDeg(heading)}deg)`;
}

function pinIcon(mine: boolean): L.DivIcon {
  return L.divIcon({
    className: "k-pin-marker",
    html: `<span aria-hidden="true" style="${mine ? "filter:drop-shadow(0 2px 3px rgba(0,0,0,.35)) drop-shadow(0 0 4px var(--accent))" : ""}">📍</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
    tooltipAnchor: [0, -24],
  });
}

const roundBtn: React.CSSProperties = {
  width: 44,
  height: 44,
  padding: 0,
  borderRadius: 999,
  fontSize: 20,
  justifyContent: "center",
};

/**
 * Leaflet map with the live bus (rotated 🚌 marker + blue trail), pickup pins,
 * street tiles (dark layer or CSS-darkened, see src/lib/map/tiles.ts), round
 * zoom / centre buttons and a LIVE / last-seen chip.
 */
export default function LiveTripMap({ tripId, initialTrip, pickupLocations, myPickupLocationId, settings, compact }: LiveTripMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const busRef = useRef<L.Marker | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const trailCasingRef = useRef<L.Polyline | null>(null);
  const pinsRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const [follow, setFollow] = useState(true);

  const { trip, points, lastPoint, isLive, lastSeenSeconds, source } = useTripLocation({
    tripId,
    initialTrip,
    staleSeconds: settings.location_stale_seconds,
  });

  const busPos = useMemo<{ lat: number; lng: number; heading: number | null } | null>(() => {
    if (lastPoint) return { lat: lastPoint.lat, lng: lastPoint.lng, heading: lastPoint.heading };
    if (trip.last_lat != null && trip.last_lng != null) return { lat: trip.last_lat, lng: trip.last_lng, heading: trip.last_heading };
    return null;
  }, [lastPoint, trip.last_lat, trip.last_lng, trip.last_heading]);

  const stale = !isLive;
  const myPickup = myPickupLocationId ? (pickupLocations.find((p) => p.id === myPickupLocationId) ?? null) : null;

  // Create the map once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      center: FALLBACK_CENTER,
      zoom: 14,
      tap: false,
    } as L.MapOptions);
    map.attributionControl.setPrefix(false);
    mapRef.current = map;

    // Tiles: with a dark provider URL the LAYER follows prefers-color-scheme (swapped on
    // change); otherwise one layer for both schemes and dark mode is a CSS filter on the
    // tile pane (globals.css). The trail colour re-reads --accent on every change.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    tileRef.current = L.tileLayer(tileUrlFor(HAS_DARK_TILES && mq.matches), TILE_LAYER_OPTIONS).addTo(map);
    const applyScheme = () => {
      const dark = mq.matches;
      if (HAS_DARK_TILES) {
        const url = tileUrlFor(dark);
        const current = tileRef.current as (L.TileLayer & { _url?: string }) | null;
        if (current && current._url !== url) {
          current.remove();
          tileRef.current = L.tileLayer(url, TILE_LAYER_OPTIONS).addTo(map);
        }
      } else {
        el.classList.toggle(MAP_DARK_CLASS, dark);
      }
      trailRef.current?.setStyle({ color: accentColor() });
    };
    applyScheme();
    mq.addEventListener("change", applyScheme);

    pinsRef.current = L.layerGroup().addTo(map);
    // The driver's path: a thin white casing under a bold accent line so it reads on any basemap.
    trailCasingRef.current = L.polyline([], { color: "#ffffff", weight: 8, opacity: 0.8, lineJoin: "round", lineCap: "round", interactive: false }).addTo(map);
    trailRef.current = L.polyline([], { color: accentColor(), weight: 5, opacity: 1, lineJoin: "round", lineCap: "round", interactive: false }).addTo(map);

    // Dragging the map turns off "follow the bus" until the user recentres.
    map.on("dragstart", () => setFollow(false));

    // Leaflet measures the container on creation; fix up after layout settles.
    const t = window.setTimeout(() => map.invalidateSize(), 50);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.invalidateSize()) : null;
    ro?.observe(el);

    return () => {
      window.clearTimeout(t);
      ro?.disconnect();
      mq.removeEventListener("change", applyScheme);
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      busRef.current = null;
      trailRef.current = null;
      trailCasingRef.current = null;
      pinsRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // Pickup pins.
  useEffect(() => {
    const group = pinsRef.current;
    if (!group) return;
    group.clearLayers();
    for (const p of pickupLocations) {
      const mine = p.id === myPickupLocationId;
      const m = L.marker([p.lat, p.lng], { icon: pinIcon(mine), interactive: true, keyboard: false, zIndexOffset: mine ? 500 : 0 });
      if (mine) m.bindTooltip("You", { permanent: true, direction: "top", className: "k-map-tip" });
      else m.bindTooltip(p.name, { direction: "top" });
      group.addLayer(m);
    }
  }, [pickupLocations, myPickupLocationId]);

  // Trail: every point known (initial fetch + broadcasts + polling merges), from the first fix on.
  useEffect(() => {
    const latLngs = points.map((p) => [p.lat, p.lng] as L.LatLngTuple);
    trailCasingRef.current?.setLatLngs(latLngs);
    trailRef.current?.setLatLngs(latLngs);
  }, [points]);

  // Bus marker + follow + first fit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (busPos) {
      const ll: L.LatLngTuple = [busPos.lat, busPos.lng];
      if (!busRef.current) {
        busRef.current = L.marker(ll, { icon: busIcon(busPos.heading, stale), zIndexOffset: 1000, keyboard: false }).addTo(map);
      } else {
        busRef.current.setLatLng(ll);
        updateBusMarker(busRef.current, busPos.heading, stale);
      }
    }
    if (!fittedRef.current) {
      const pts: L.LatLngTuple[] = pickupLocations.map((p) => [p.lat, p.lng]);
      if (busPos) pts.push([busPos.lat, busPos.lng]);
      if (pts.length >= 2) {
        map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 16 });
        fittedRef.current = true;
      } else if (pts.length === 1) {
        map.setView(pts[0] as L.LatLngTuple, 15);
        fittedRef.current = true;
      }
      // With nothing known yet keep the fallback view and try again on the next fix.
    } else if (busPos && follow) {
      map.panTo([busPos.lat, busPos.lng], { animate: true, duration: 0.6 });
    }
  }, [busPos, stale, follow, pickupLocations]);

  const centreOnBus = () => {
    const map = mapRef.current;
    if (!map || !busPos) return;
    setFollow(true);
    map.setView([busPos.lat, busPos.lng], Math.max(map.getZoom(), 15), { animate: true });
  };

  const distanceM = busPos && myPickup ? haversineM(busPos, myPickup) : null;
  const etaText = distanceM != null ? formatEta(estimateEtaSeconds(distanceM)) : null;
  const distText = formatDistance(distanceM);

  let chip: { live: boolean; text: string };
  if (isLive) chip = { live: true, text: `Live · updated ${agoFromSeconds(lastSeenSeconds ?? 0)}` };
  else if (lastSeenSeconds != null && (trip.status === "boarding" || trip.status === "departed")) chip = { live: false, text: `Last seen ${agoFromSeconds(lastSeenSeconds)}` };
  else if (trip.status === "arrived") chip = { live: false, text: "Trip finished" };
  else if (trip.status === "cancelled" || trip.status === "expired") chip = { live: false, text: "Trip cancelled" };
  else chip = { live: false, text: "Bus not sharing yet" };

  return (
    <div
      className="k-map"
      style={{
        position: "relative",
        height: compact ? 220 : "max(320px, calc(100dvh - 300px))",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
        background: "var(--surface-3)",
        boxShadow: "var(--shadow)",
      }}
    >
      <div
        ref={containerRef}
        // touch-action none: Leaflet handles every gesture itself, so Safari must not try to scroll or double-tap-zoom the page.
        style={{ position: "absolute", inset: 0, touchAction: "none", WebkitTapHighlightColor: "transparent" }}
        aria-label="Live shuttle map"
        role="application"
      />

      {/* status chip */}
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 500, display: "flex", gap: 6, alignItems: "center" }}>
        <span className={["k-live", chip.live ? "" : "k-live--off"].filter(Boolean).join(" ")} style={{ boxShadow: "var(--shadow)", textTransform: "none", letterSpacing: 0 }} aria-live="polite">
          {chip.text}
        </span>
        {source === "polling" && !compact ? (
          <span className="k-pill k-pill--sm k-pill--ghost" style={{ background: "var(--surface)" }} title="Live updates unavailable; refreshing every 10 s">
            ⟳ 10 s
          </span>
        ) : null}
      </div>

      {/* round controls */}
      <div style={{ position: "absolute", right: 10, bottom: distText ? 64 : 10, zIndex: 500, display: "flex", flexDirection: "column", gap: 8 }}>
        {!compact ? (
          <>
            <button type="button" className="k-filter" style={roundBtn} aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
              +
            </button>
            <button type="button" className="k-filter" style={roundBtn} aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
              −
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="k-filter"
          style={roundBtn}
          aria-pressed={follow && !!busPos}
          aria-label="Centre on bus"
          title="Centre on bus"
          onClick={centreOnBus}
          disabled={!busPos}
        >
          🎯
        </button>
      </div>

      {/* distance / ETA card */}
      {distText && myPickup ? (
        <div
          style={{
            position: "absolute",
            left: 10,
            right: 64,
            bottom: 10,
            zIndex: 500,
            background: "var(--surface)",
            color: "var(--text)",
            borderRadius: "var(--radius-list)",
            boxShadow: "var(--lift-shadow)",
            padding: "8px 12px",
            fontSize: "var(--fs-sm)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 18 }}>
            📍
          </span>
          <span style={{ minWidth: 0 }}>
            <strong style={{ display: "block", fontSize: "var(--fs-md)" }}>
              {distText} to {myPickup.name}
            </strong>
            <span style={{ color: "var(--hint)" }}>{etaText ? `About ${etaText}${stale ? " · last known position" : ""}` : "Almost there"}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
