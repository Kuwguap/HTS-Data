import type { Booking, BookingStatus, PickupRequestStatus, Settings, Trip, TripDirection, TripStatus } from "@/lib/db.types";
import { formatFare, formatTime, isStale, minutesBetween } from "@/lib/time";

/** Pure helpers shared by student, driver and admin screens. Keep them free of React/Next. */

export function seatsLeft(trip: Pick<Trip, "seat_capacity" | "confirmed_count">): number {
  return Math.max(0, trip.seat_capacity - trip.confirmed_count);
}

export function directionLabel(direction: TripDirection, settings?: Pick<Settings, "hostel_name" | "campus_name">): string {
  if (direction === "to_campus") return `To ${settings?.campus_name ?? "campus"}`;
  return `To ${settings?.hostel_name ?? "the hostel"}`;
}

export function directionShort(direction: TripDirection): string {
  return direction === "to_campus" ? "To campus" : "To hostel";
}

/** "7:30 AM · To campus" */
export function tripTitle(trip: Pick<Trip, "departure_at" | "direction">, timeZone?: string): string {
  return `${formatTime(trip.departure_at, timeZone)} · ${directionShort(trip.direction)}`;
}

export const TRIP_STATUS_LABEL: Record<TripStatus, string> = {
  scheduled: "Scheduled",
  boarding: "Boarding",
  departed: "On the way",
  arrived: "Arrived",
  cancelled: "Cancelled",
  expired: "Missed",
};

export type Tone = "blue" | "green" | "amber" | "red" | "purple" | "teal" | "neutral";

export const TRIP_STATUS_TONE: Record<TripStatus, Tone> = {
  scheduled: "blue",
  boarding: "amber",
  departed: "green",
  arrived: "neutral",
  cancelled: "red",
  expired: "neutral",
};

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: "Seat reserved",
  waitlisted: "Waitlist",
  cancelled: "Cancelled",
  boarded: "On board",
  no_show: "No show",
};

export const BOOKING_STATUS_TONE: Record<BookingStatus, Tone> = {
  confirmed: "green",
  waitlisted: "amber",
  cancelled: "neutral",
  boarded: "blue",
  no_show: "red",
};

export const PICKUP_STATUS_LABEL: Record<PickupRequestStatus, string> = {
  pending: "Waiting for driver",
  accepted: "Driver accepted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  completed: "Picked up",
};

export const PICKUP_STATUS_TONE: Record<PickupRequestStatus, Tone> = {
  pending: "amber",
  accepted: "green",
  declined: "red",
  cancelled: "neutral",
  expired: "neutral",
  completed: "blue",
};

/** A booking that still counts as "mine" for a trip. */
export function isActiveBooking(b: Pick<Booking, "status"> | null | undefined): boolean {
  return !!b && (b.status === "confirmed" || b.status === "waitlisted" || b.status === "boarded");
}

/** Can a student book/cancel on this trip right now? */
export function isBookingOpen(
  trip: Pick<Trip, "status" | "bookings_enabled" | "departure_at">,
  settings: Pick<Settings, "booking_cutoff_minutes">,
  now: Date = new Date(),
): boolean {
  if (!trip.bookings_enabled) return false;
  if (trip.status !== "scheduled" && trip.status !== "boarding") return false;
  return minutesBetween(now, trip.departure_at) > settings.booking_cutoff_minutes;
}

/** Is the bus currently sending positions for this trip? */
export function isTripLive(
  trip: Pick<Trip, "status" | "last_location_at">,
  settings: Pick<Settings, "location_stale_seconds">,
  now: Date = new Date(),
): boolean {
  if (trip.status !== "boarding" && trip.status !== "departed") return false;
  return !isStale(trip.last_location_at, settings.location_stale_seconds, now);
}

export function isTripActive(trip: Pick<Trip, "status">): boolean {
  return trip.status === "scheduled" || trip.status === "boarding" || trip.status === "departed";
}

/** Next upcoming trip (by departure) that is still active. */
export function nextTrip<T extends Pick<Trip, "status" | "departure_at">>(trips: T[], now: Date = new Date()): T | null {
  const upcoming = trips
    .filter((t) => isTripActive(t) && new Date(t.departure_at).getTime() >= now.getTime() - 15 * 60_000)
    .sort((a, b) => new Date(a.departure_at).getTime() - new Date(b.departure_at).getTime());
  return upcoming[0] ?? null;
}

/** "GH₵10 · cash only" */
export function fareLine(settings: Pick<Settings, "fare_pesewas" | "currency">): string {
  return `${formatFare(settings.fare_pesewas, settings.currency)} · cash only`;
}

/** Initials for avatars: "Ama Mensah" → "AM" */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** "Gate A ×4, Block C ×2" */
export function pickupSummary(groups: Array<{ name: string; count: number }>): string {
  return groups
    .filter((g) => g.count > 0)
    .map((g) => `${g.name} ×${g.count}`)
    .join(", ");
}
