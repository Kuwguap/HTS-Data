import type { NotificationKind } from "@/lib/db.types";

/**
 * Default message templates — must match supabase/migrations/0008_seed.sql (and the
 * later per-kind seeds such as 0013_pickup_request_cancelled_template.sql).
 * Used by /admin/templates for "Restore default" and the live preview.
 */
export const TEMPLATE_DEFAULTS: Record<NotificationKind, { title: string; body: string }> = {
  daily_announcement: { title: "🚌 Shuttle today", body: "Departures: {times}. Fare {fare}, cash only. Tap to book your seat." },
  trip_reminder: { title: "🚌 Shuttle at {time}", body: "{seats_left}/{seats} seats left. {fare} cash. Tap to opt in." },
  trip_nudge: { title: "⏰ Leaving in {count} min", body: "Be at {pickup}. Have {fare} cash ready." },
  trip_departed: { title: "🚌 Shuttle has left", body: "The {time} shuttle to {destination} has departed." },
  booking_confirmed: { title: "✅ Seat reserved", body: "You're on the {time} shuttle to {destination}. Pickup: {pickup}. {fare} cash." },
  booking_waitlisted: { title: "⏳ You're on the waitlist", body: "Position {count} for the {time} shuttle. We'll tell you if a seat opens." },
  booking_promoted: { title: "🎉 A seat opened up", body: "You're now confirmed for the {time} shuttle to {destination}. Be at {pickup}." },
  booking_cancelled: { title: "❌ Booking cancelled", body: "Your seat on the {time} shuttle to {destination} was cancelled. {message}" },
  trip_cancelled: { title: "⚠️ Shuttle cancelled", body: "The {time} shuttle to {destination} is cancelled. {message}" },
  trip_updated: { title: "🔄 Shuttle updated", body: "The {time} shuttle to {destination} has changed. {message}" },
  driver_manifest: { title: "📋 {time} to {destination}", body: "{count} riders — {summary}" },
  driver_booking_update: { title: "💺 Booking update", body: "{name} {message} ({pickup}) for the {time} shuttle." },
  pickup_request_new: { title: "✋ Pickup request", body: "{name} at {pickup}. {message}" },
  pickup_request_accepted: { title: "✅ Pickup accepted", body: "Wait at {pickup}. {message}" },
  pickup_request_declined: { title: "❌ Pickup declined", body: "{message}" },
  pickup_request_expired: { title: "⌛ Pickup request expired", body: "Nobody responded to your request at {pickup}. Try again or call the office." },
  pickup_request_cancelled: { title: "🙅 Pickup request withdrawn", body: "{name} no longer needs a pickup at {pickup}." },
  return_announcement: { title: "🚌 Shuttle heading to {hostel}", body: "Shuttle at {origin} → {hostel}. Leaving in {count} min. Tap if you're coming." },
  broadcast: { title: "📣 {title}", body: "{message}" },
  test: { title: "🔔 Notifications are on", body: "You'll get shuttle reminders here, {name}." },
};

export const TEMPLATE_KINDS = Object.keys(TEMPLATE_DEFAULTS) as NotificationKind[];

export function isNotificationKind(value: string): value is NotificationKind {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_DEFAULTS, value);
}

export type TemplateMeta = {
  label: string;
  /** When it is sent and to whom. */
  when: string;
  placeholders: string[];
};

/**
 * Human labels, triggers and placeholders per kind (shown on /admin/templates).
 * `placeholders` lists only the variables EVERY sender of that kind passes (run_tick in
 * 0005_fn_trips_tick.sql plus the src/app/api routes), so a chip never inserts a blank.
 */
export const TEMPLATE_META: Record<NotificationKind, TemplateMeta> = {
  daily_announcement: { label: "Daily announcement", when: "Every morning at the announcement time · all students with reminders on", placeholders: ["hostel", "campus", "times", "fare", "date"] },
  trip_reminder: { label: "Trip reminder", when: "Before each departure (reminder lead) · students without a seat", placeholders: ["time", "seats_left", "seats", "fare", "origin", "destination", "hostel"] },
  trip_nudge: { label: "Leaving-soon nudge", when: "Minutes before departure (nudge) · riders with a seat", placeholders: ["count", "time", "pickup", "fare", "destination"] },
  trip_departed: { label: "Shuttle departed", when: "When the driver taps Depart · riders not on board", placeholders: ["time", "destination"] },
  booking_confirmed: { label: "Seat confirmed", when: "Right after a student reserves a seat", placeholders: ["time", "destination", "pickup", "fare", "date"] },
  booking_waitlisted: { label: "Waitlisted", when: "When the shuttle is full and the student joins the waitlist", placeholders: ["count", "time", "destination", "pickup"] },
  booking_promoted: { label: "Promoted from waitlist", when: "When a seat opens up for a waitlisted student", placeholders: ["time", "destination", "pickup"] },
  booking_cancelled: { label: "Booking cancelled", when: "When staff cancel a student's seat", placeholders: ["time", "destination", "message"] },
  trip_cancelled: { label: "Trip cancelled", when: "When an admin or driver cancels a departure · booked riders", placeholders: ["time", "destination", "message"] },
  trip_updated: { label: "Trip updated", when: "When the departure time changes or a day off is lifted · booked riders and the driver", placeholders: ["time", "date", "destination", "message"] },
  driver_manifest: { label: "Driver manifest", when: "Before departure (manifest lead) · the trip's driver", placeholders: ["time", "destination", "count", "summary"] },
  driver_booking_update: { label: "Driver booking update", when: "After the manifest went out and a booking changes · the driver", placeholders: ["name", "message", "pickup", "time"] },
  pickup_request_new: { label: "New pickup request", when: "When a student asks for a pickup · the driver", placeholders: ["name", "pickup", "message"] },
  pickup_request_accepted: { label: "Pickup accepted", when: "When the driver accepts · the student", placeholders: ["pickup", "message"] },
  pickup_request_declined: { label: "Pickup declined", when: "When the driver declines · the student", placeholders: ["pickup", "message"] },
  pickup_request_expired: { label: "Pickup request expired", when: "When nobody responded in time · the student", placeholders: ["pickup"] },
  pickup_request_cancelled: { label: "Pickup request withdrawn", when: "When a student withdraws a request the driver had accepted · the driver", placeholders: ["name", "pickup"] },
  return_announcement: { label: "Return announcement", when: "When the driver announces a return trip · all students", placeholders: ["origin", "hostel", "count", "seats"] },
  broadcast: { label: "Announcement (broadcast)", when: "When an admin sends an announcement", placeholders: ["title", "message", "hostel"] },
  test: { label: "Test notification", when: "When someone turns on reminders", placeholders: ["name"] },
};

/** Sample values for the live preview on /admin/templates. */
export const TEMPLATE_SAMPLE_VARS: Record<string, string> = {
  hostel: "Kharis Courts Hostel",
  campus: "KNUST",
  time: "7:30 AM",
  date: "Mon 27 Oct",
  times: "7:30 AM, 9:30 AM, 11:30 AM, 1:30 PM, 3:30 PM",
  fare: "GH₵10",
  seats_left: "12",
  seats: "14",
  pickup: "Hostel main gate",
  name: "Ama",
  origin: "KSB",
  destination: "KNUST",
  count: "3",
  summary: "Hostel main gate ×4, Hostel car park ×2",
  message: "Driver is unwell",
  title: "Water outage",
};

/**
 * Same substitution as SQL render_text (0004_fn_notify.sql): one pass over the ORIGINAL
 * template (a value containing "{other}" is emitted literally, never re-expanded), unknown
 * placeholders → '', runs of spaces/tabs collapse to one space, newlines are kept, then trim.
 */
export function renderTemplate(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => {
      const v = vars[key];
      return v == null ? "" : String(v);
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
