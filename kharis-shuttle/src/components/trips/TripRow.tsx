"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { StudentTrip } from "@/lib/data/student";
import type { PickupLocation, Settings } from "@/lib/db.types";
import { formatFare, formatTime } from "@/lib/time";
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  TRIP_STATUS_LABEL,
  TRIP_STATUS_TONE,
  directionShort,
  isActiveBooking,
  isBookingOpen,
  isTripLive,
  seatsLeft,
} from "@/lib/trips";
import { Art, Button, Pill, Row } from "@/components/ui";
import { BookSheet } from "./BookSheet";
import { CancelBookingButton } from "./CancelBookingButton";

export type TripRowSettings = Pick<
  Settings,
  "timezone" | "fare_pesewas" | "currency" | "booking_cutoff_minutes" | "location_stale_seconds"
>;

export type TripRowProps = {
  trip: StudentTrip;
  settings: TripRowSettings;
  pickupLocations: PickupLocation[];
  /** Server time in ms, so SSR and hydration agree on what is open. */
  nowMs: number;
};

/**
 * One departure in the Today list: time, direction + seats, my status pill and
 * the right action (Book / Cancel / Track).
 */
export function TripRow({ trip, settings, pickupLocations, nowMs }: TripRowProps) {
  const now = new Date(nowMs);
  const tz = settings.timezone;
  const mine = isActiveBooking(trip.my_booking) ? trip.my_booking : null;
  const open = isBookingOpen(trip, settings, now);
  const live = isTripLive(trip, settings, now);
  const moving = trip.status === "boarding" || trip.status === "departed";
  const left = seatsLeft(trip);

  const subtitleParts = [directionShort(trip.direction), `${left} of ${trip.seat_capacity} seats`];
  if (mine?.pickup_location?.name) subtitleParts.push(mine.pickup_location.name);
  else if (mine?.status === "waitlisted" && mine.waitlist_position) subtitleParts.push(`#${mine.waitlist_position} waiting`);

  let pill: ReactNode = null;
  if (mine) {
    pill = (
      <Pill tone={BOOKING_STATUS_TONE[mine.status]} sm>
        {BOOKING_STATUS_LABEL[mine.status]}
      </Pill>
    );
  } else if (trip.status !== "scheduled") {
    pill = (
      <Pill tone={TRIP_STATUS_TONE[trip.status]} sm>
        {live ? "Live" : TRIP_STATUS_LABEL[trip.status]}
      </Pill>
    );
  } else if (left === 0) {
    pill = (
      <Pill tone="amber" sm>
        Full
      </Pill>
    );
  }

  let action: ReactNode = null;
  if (moving) {
    action = (
      <Button pill size="sm" variant={live ? "primary" : "secondary"} href={`/app/trips/${trip.id}/map`}>
        Track
      </Button>
    );
  } else if (mine && open) {
    action = <CancelBookingButton bookingId={mine.id} tripLabel={formatTime(trip.departure_at, tz)} waitlisted={mine.status === "waitlisted"} />;
  } else if (!mine && open) {
    action = (
      <BookSheet
        trip={trip}
        pickupLocations={pickupLocations}
        fare={formatFare(settings.fare_pesewas, settings.currency)}
        timeZone={tz}
        nowMs={nowMs}
      />
    );
  }

  return (
    <Row
      leading={<Art k="bus" size={32} />}
      title={
        <Link href={`/app/trips/${trip.id}`} style={{ color: "inherit", display: "block" }}>
          {formatTime(trip.departure_at, tz)}
        </Link>
      }
      subtitle={subtitleParts.join(" · ")}
      trailing={
        <span className="flex items-center gap-2" style={{ flex: "0 0 auto" }}>
          {pill}
          {action}
        </span>
      }
      chevron={false}
    />
  );
}
