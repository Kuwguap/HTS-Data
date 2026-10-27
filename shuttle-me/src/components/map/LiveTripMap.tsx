"use client";

// Only ever loaded through LiveTripMapLoader (next/dynamic, ssr: false): Leaflet touches `window` at import time.
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BookingStatus, PickupLocation, Trip } from "@/lib/db.types";
import { estimateEtaSeconds, formatDistance, formatEta, haversineM, type LatLng } from "@/lib/geo";
import { useTripLocation } from "@/hooks/useTripLocation";
import { useTripRoute, viaKeyOf } from "@/hooks/useTripRoute";
import { createBasemap, type Basemap } from "@/lib/map/basemap";
import { chipOptions, flagIcon, pinIcon } from "@/lib/map/icons";
import { placeLabels } from "@/lib/map/labels";
import { TILE_MAX_ZOOM } from "@/lib/map/tiles";

export type LiveTripMapProps = {
  tripId: string;
  initialTrip: Trip;
  pickupLocations: PickupLocation[];
  /** The viewer's own pickup point (highlighted with a "You" tooltip, used for distance/ETA). */
  myPickupLocationId?: string | null;
  /** The viewer's booking status: only a `confirmed` (not yet boarded) rider's pickup becomes a via point of the road route. */
  myBookingStatus?: BookingStatus | null;
  settings: { timezone: string; location_stale_seconds: number; hostel_name: string; campus_name: string };
  /** Where the trip ends (hostel or campus), labelled with its name; omitted when unknown. */
  destination?: { lat: number; lng: number; name: string } | null;
  /** Small 220px preview (driver tracking screen) instead of a tall map. */
  compact?: boolean;
};

// Kumasi (KNUST) — only used before any pin or fix is known.
const FALLBACK_CENTER: L.LatLngExpression = [6.6745, -1.5716];
/** Once the bus is this close to the viewer's pickup the route no longer detours through it. */
const VIA_REACHED_M = 80;

const toTuple = (p: LatLng): L.LatLngTuple => [p.lat, p.lng];

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

const roundBtn: React.CSSProperties = {
  width: 44,
  height: 44,
  padding: 0,
  borderRadius: 999,
  fontSize: 20,
  justifyContent: "center",
};

/**
 * Leaflet map with the live bus (rotated 🚌 marker + blue trail snapped to roads),
 * the dashed road route ahead, pickup pins, street tiles (dark layer or
 * CSS-darkened, see src/lib/map/tiles.ts), round zoom / centre buttons and a
 * LIVE / last-seen chip.
 */
export default function LiveTripMap({ tripId, initialTrip, pickupLocations, myPickupLocationId, myBookingStatus, settings, destination, compact }: LiveTripMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const basemapRef = useRef<Basemap | null>(null);
  const busRef = useRef<L.Marker | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const trailCasingRef = useRef<L.Polyline | null>(null);
  const routeRef = useRef<L.Polyline | null>(null);
  const pinsRef = useRef<L.LayerGroup | null>(null);
  const destRef = useRef<L.Marker | null>(null);
  const fittedRef = useRef(false);
  const routeFittedRef = useRef(false);
  const [follow, setFollow] = useState(true);
  // Bumped on every zoom so the stop chips are re-spread for the new scale.
  const [zoomTick, setZoomTick] = useState(0);

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

  // The route detours through the viewer's pickup only while they still wait there for the bus.
  const viaActive = !!myPickup && myBookingStatus === "confirmed" && !!busPos && haversineM(busPos, myPickup) > VIA_REACHED_M;
  const viaPos = useMemo<LatLng | null>(() => (viaActive && myPickup ? { lat: myPickup.lat, lng: myPickup.lng } : null), [viaActive, myPickup]);
  const { route, matched } = useTripRoute({
    tripId,
    busPos,
    viaPos,
    enabled: trip.status === "boarding" || trip.status === "departed",
    latestPointKey: lastPoint?.id ?? null,
  });

  // Travelled trail: the road-snapped geometry for the fixes it covers, raw fixes before and after it.
  const trailLatLngs = useMemo<L.LatLngTuple[]>(() => {
    if (!matched) return points.map(toTuple);
    const before = matched.fromRecordedAt ? points.filter((p) => p.recorded_at < matched.fromRecordedAt!) : [];
    const after = matched.throughRecordedAt ? points.filter((p) => p.recorded_at > matched.throughRecordedAt!) : [];
    return [...before.map(toTuple), ...matched.geometry.map(toTuple), ...after.map(toTuple)];
  }, [points, matched]);

  // Create the map once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      center: FALLBACK_CENTER,
      zoom: 14,
      minZoom: 2,
      maxZoom: TILE_MAX_ZOOM,
      tap: false,
    } as L.MapOptions);
    map.attributionControl.setPrefix(false);
    mapRef.current = map;

    // Basemap (vector style with real place names, raster fallback — src/lib/map/basemap.ts)
    // follows prefers-color-scheme; the trail colour re-reads --accent on every change.
    let cancelled = false;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    void createBasemap(L, map, mq.matches, () => cancelled).then((basemap) => {
      if (cancelled) {
        basemap.remove();
        return;
      }
      basemapRef.current = basemap;
      // The scheme may have changed while the chunk downloaded: apply the current one.
      basemap.setDark(mq.matches);
    });
    const applyScheme = () => {
      basemapRef.current?.setDark(mq.matches);
      const accent = accentColor();
      trailRef.current?.setStyle({ color: accent });
      routeRef.current?.setStyle({ color: accent });
    };
    mq.addEventListener("change", applyScheme);

    pinsRef.current = L.layerGroup().addTo(map);
    // The road ahead: dotted accent line (under the trail; markers live in a higher pane anyway).
    routeRef.current = L.polyline([], { color: accentColor(), weight: 5, opacity: 0.55, dashArray: "2 10", lineCap: "round", lineJoin: "round", interactive: false }).addTo(map);
    // The driver's path: a thin white casing under a bold accent line so it reads on any basemap.
    trailCasingRef.current = L.polyline([], { color: "#ffffff", weight: 8, opacity: 0.8, lineJoin: "round", lineCap: "round", interactive: false }).addTo(map);
    trailRef.current = L.polyline([], { color: accentColor(), weight: 5, opacity: 1, lineJoin: "round", lineCap: "round", interactive: false }).addTo(map);

    // Dragging the map turns off "follow the bus" until the user recentres.
    map.on("dragstart", () => setFollow(false));
    map.on("zoomend", () => setZoomTick((n) => n + 1));

    // Leaflet measures the container on creation; fix up after layout settles.
    const t = window.setTimeout(() => map.invalidateSize(), 50);
    // A collapsed (0×0, leaving the page) or detached container never needs a re-measure.
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (el.isConnected && el.clientWidth > 0 && el.clientHeight > 0) map.invalidateSize();
          })
        : null;
    ro?.observe(el);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      ro?.disconnect();
      mq.removeEventListener("change", applyScheme);
      basemapRef.current?.remove();
      basemapRef.current = null;
      map.remove();
      mapRef.current = null;
      busRef.current = null;
      trailRef.current = null;
      trailCasingRef.current = null;
      routeRef.current = null;
      pinsRef.current = null;
      destRef.current = null;
      fittedRef.current = false;
      routeFittedRef.current = false;
    };
  }, []);

  // Pickup pins.
  useEffect(() => {
    const group = pinsRef.current;
    if (!group) return;
    group.clearLayers();
    // Chip sides are chosen in screen space at the current zoom so stops that sit close
    // together fan out (top / bottom / right / left) instead of printing over each other.
    const map = mapRef.current;
    const items = pickupLocations.map((p) => {
      const c = map ? map.latLngToContainerPoint([p.lat, p.lng]) : { x: 0, y: 0 };
      return { x: c.x, y: c.y, text: p.id === myPickupLocationId ? `You · ${p.name}` : p.name };
    });
    const size = map?.getSize();
    const dirs = placeLabels(items, size ? { w: size.x, h: size.y } : undefined);
    pickupLocations.forEach((p, i) => {
      const mine = p.id === myPickupLocationId;
      const m = L.marker([p.lat, p.lng], { icon: pinIcon(L, mine), interactive: true, keyboard: false, zIndexOffset: mine ? 500 : 0 });
      // Every stop shows its name, like the place names on the basemap; the viewer's own stop is highlighted.
      m.bindTooltip(mine ? `You · ${p.name}` : p.name, chipOptions(dirs[i] ?? "top", mine ? "mine" : "plain"));
      group.addLayer(m);
    });
  }, [pickupLocations, myPickupLocationId, zoomTick]);

  // Destination flag with the hostel/campus name (skipped when it coincides with a pickup pin, which already carries a label).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    destRef.current?.remove();
    destRef.current = null;
    if (!destination) return;
    const onAPin = pickupLocations.some((p) => haversineM(p, destination) < 25);
    if (onAPin) return;
    const m = L.marker([destination.lat, destination.lng], { icon: flagIcon(L), interactive: false, keyboard: false, zIndexOffset: 400 }).addTo(map);
    m.bindTooltip(destination.name, chipOptions("top", "dest"));
    destRef.current = m;
  }, [destination, pickupLocations]);

  // Trail: the road-snapped geometry when the matcher answered, else every raw fix from the first on.
  useEffect(() => {
    trailCasingRef.current?.setLatLngs(trailLatLngs);
    trailRef.current?.setLatLngs(trailLatLngs);
  }, [trailLatLngs]);

  // Route ahead. The first route widens the initial view once (unless the viewer already dragged).
  useEffect(() => {
    const map = mapRef.current;
    routeRef.current?.setLatLngs(route ? route.geometry.map(toTuple) : []);
    if (!map || !route || routeFittedRef.current) return;
    routeFittedRef.current = true;
    if (!follow) return;
    const pts: L.LatLngTuple[] = [...pickupLocations.map(toTuple), ...route.geometry.map(toTuple)];
    if (busPos) pts.push([busPos.lat, busPos.lng]);
    if (destination) pts.push([destination.lat, destination.lng]);
    map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 16 });
    fittedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit once when the first route lands; later bus/pin changes must not refit
  }, [route]);

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
      const pts: L.LatLngTuple[] = pickupLocations.map(toTuple);
      if (busPos) pts.push([busPos.lat, busPos.lng]);
      if (route) pts.push(...route.geometry.map(toTuple));
      if (destination) pts.push([destination.lat, destination.lng]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `route` is only read for the one-off first fit; its own effect handles later changes
  }, [busPos, stale, follow, pickupLocations]);

  const centreOnBus = () => {
    const map = mapRef.current;
    if (!map || !busPos) return;
    setFollow(true);
    map.setView([busPos.lat, busPos.lng], Math.max(map.getZoom(), 15), { animate: true });
  };

  // ETA to the viewer's pickup: the road route's first leg (bus → pickup) when the route went through it, else straight-line × 1.3.
  const roadLeg = route && viaPos && route.viaKey === viaKeyOf(viaPos) && route.legs.length >= 2 ? route.legs[0]! : null;
  const distanceM = roadLeg ? roadLeg.distanceM : busPos && myPickup ? haversineM(busPos, myPickup) : null;
  const etaText = roadLeg ? formatEta(roadLeg.durationS) : distanceM != null ? formatEta(estimateEtaSeconds(distanceM)) : null;
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
        style={{ position: "absolute", inset: 0, touchAction: "none", WebkitTapHighlightColor: "transparent", background: "var(--surface-3)" }}
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
            <span style={{ color: "var(--hint)" }}>
              {etaText ? `About ${etaText}${roadLeg ? ` · ${distText} by road` : ""}${stale ? " · last known position" : ""}` : "Almost there"}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
