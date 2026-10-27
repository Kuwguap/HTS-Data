import type { LatLng } from "@/lib/geo";
import type { PickupLocation, Settings, Trip } from "@/lib/db.types";

type Coords = Pick<Settings, "hostel_lat" | "hostel_lng" | "campus_lat" | "campus_lng">;
type Stop = Pick<PickupLocation, "direction" | "lat" | "lng" | "is_active">;

/** The first active pickup point for `direction`, in the order the list was given (sort_order, name). */
function firstStop(stops: Stop[], direction: PickupLocation["direction"]): LatLng | null {
  const s = stops.find((p) => p.is_active && p.direction === direction);
  return s ? { lat: s.lat, lng: s.lng } : null;
}

/**
 * Where a trip is heading, for the road route on the live map.
 *
 * - `to_campus` → the campus coordinates from settings, else the first active pickup
 *   point whose direction is `to_hostel` (those stops stand on campus).
 * - `to_hostel` → the hostel coordinates, else the first active `to_campus` pickup.
 * - `null` when nothing is known (no route is drawn, the map keeps the straight trail).
 */
export function tripDestination(trip: Pick<Trip, "direction">, settings: Coords, pickupLocations: Stop[]): LatLng | null {
  if (trip.direction === "to_campus") {
    if (settings.campus_lat != null && settings.campus_lng != null) return { lat: settings.campus_lat, lng: settings.campus_lng };
    return firstStop(pickupLocations, "to_hostel");
  }
  if (settings.hostel_lat != null && settings.hostel_lng != null) return { lat: settings.hostel_lat, lng: settings.hostel_lng };
  return firstStop(pickupLocations, "to_campus");
}
