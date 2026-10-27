# Live trip map

Shared by the student map (`/app/trips/[id]/map`) and the driver tracking screen (`/driver/trips/[id]/track`).

## Use it

```tsx
import LiveTripMapLoader from "@/components/map/LiveTripMapLoader";

<LiveTripMapLoader
  tripId={trip.id}
  initialTrip={trip}                     // full Trip row (seed; the hook keeps it fresh)
  pickupLocations={pickupLocations}      // PickupLocation[] (active ones)
  myPickupLocationId={booking?.pickup_location_id ?? null}
  settings={{
    timezone: settings.timezone,
    location_stale_seconds: settings.location_stale_seconds,
    hostel_name: settings.hostel_name,
    campus_name: settings.campus_name,
  }}
  compact                                // optional: 220px preview instead of a tall map
/>
```

Always import **`LiveTripMapLoader`** (a `next/dynamic` wrapper with `ssr: false` and a skeleton). `LiveTripMap.tsx` imports Leaflet at module level and must never run on the server.

## Props

| prop | type | notes |
|---|---|---|
| `tripId` | `string` | drives the fetch + realtime subscription |
| `initialTrip` | `Trip` | server-rendered seed (`status`, `last_*`) |
| `pickupLocations` | `PickupLocation[]` | rendered as 📍 pins with name tooltips |
| `myPickupLocationId` | `string \| null?` | that pin gets a permanent **You** tooltip; enables the distance/ETA card |
| `settings` | `{ timezone, location_stale_seconds, hostel_name, campus_name }` | staleness threshold etc. |
| `compact` | `boolean?` | 220px tall, no zoom buttons (driver preview) |

## Behaviour

* **Tiles**: Esri World Street Map (no API key) from `src/lib/map/tiles.ts`, one layer for both schemes. Dark mode = CSS filter on the tile pane only (`.k-map-dark .leaflet-tile-pane` in `globals.css`; the class follows `prefers-color-scheme` live, markers/trail/tooltips/controls stay untouched). Set `NEXT_PUBLIC_MAP_TILE_URL` (+ `NEXT_PUBLIC_MAP_TILE_ATTRIBUTION`) to switch provider; a custom provider's tiles are network-only unless its host is added to `public/sw.js` (and `src/lib/push/sw-logic.ts`).
* **Bus**: `L.divIcon` `.k-bus-marker` with 🚌 rotated by heading; `.k-bus-marker--stale` (grey) once no fix arrived within `location_stale_seconds`.
* **Trail**: polyline in `--accent`, weight 4, from every point known (initial fetch + broadcasts).
* **Pins**: `.k-pin-marker` 📍 per pickup location.
* **Controls**: round `.k-filter` buttons bottom-right — zoom ±, and 🎯 "Centre on bus" (also re-enables following; dragging the map stops following).
* **Fit**: bounds (pins + bus) fitted once; afterwards the map follows the bus while `follow` is on.
* **Chip** (top-left): `Live · updated 5s ago` / `Last seen 3 min ago` / `Bus not sharing yet` / `Trip finished`; a small `⟳ 10 s` pill appears while on polling fallback.
* **Distance / ETA** (bottom card): haversine from bus to `myPickupLocationId` + `estimateEtaSeconds` (straight-line × 1.3 at ~23 km/h). Only when both are known.

## Data: `useTripLocation`

```ts
const { trip, points, lastPoint, isLive, lastSeenSeconds, source, refresh } =
  useTripLocation({ tripId, initialTrip, staleSeconds });
```

1. `GET /api/trips/[id]/location` (F2's route) → `{ trip: {id,status,last_lat,last_lng,last_heading,last_speed_mps,last_location_at}, points: [{id, lat, lng, heading, speed_mps, accuracy_m, recorded_at}] }`; later calls add `?since=<last point id>`.
2. `supabase.realtime.setAuth()` then `channel('trip:<id>', { config: { private: true } })`
   * `broadcast` event `location` → payload `TripLocationBroadcast` (from the `trip_locations` insert trigger) appended to `points` (synthetic negative id; de-duplicated by `recorded_at`).
   * `postgres_changes` UPDATE on `trips` `id=eq.<id>` → `trip` (status / last_*).
3. Polling every 10 s if the channel is not `SUBSCRIBED` within 5 s, or after `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`; stops when the channel subscribes. Refetch on `visibilitychange → visible`.
4. `source` is `'realtime' | 'polling' | 'idle'`; `lastSeenSeconds` ticks every second; `isLive` = boarding/departed **and** a fix within `staleSeconds`.

Everything is cleaned up on unmount (`removeChannel`, timers, listeners).

## CSS

Marker classes live in `src/app/globals.css` (`.k-bus-marker`, `.k-bus-marker--stale`, `.k-pin-marker`). Leaflet's own stylesheet is imported by `LiveTripMap.tsx`.
