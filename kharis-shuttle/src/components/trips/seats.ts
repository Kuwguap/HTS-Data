import type { Trip } from "@/lib/db.types";
import { seatsLeft } from "@/lib/trips";

/**
 * Does a new booking land on the waitlist? Mirrors book_seat(): a newcomer is
 * waitlisted when no seat is left OR someone is already waiting (so nobody can
 * jump the queue while a freed seat has not been promoted yet).
 */
export function isWaitlistOnly(trip: Pick<Trip, "seat_capacity" | "confirmed_count" | "waitlist_count">): boolean {
  return seatsLeft(trip) <= 0 || trip.waitlist_count > 0;
}
