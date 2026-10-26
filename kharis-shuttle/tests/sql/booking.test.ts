import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  IDS,
  assertCountersConsistent,
  book,
  errorOf,
  makeTrip,
  one,
  resetDb,
  rows,
  scalar,
  trip,
  type BookingRow,
  type TripRow,
} from "./helpers";

let c: Client;

beforeAll(async () => {
  c = await resetDb();
});

afterAll(async () => {
  await c?.end();
});

describe("book_seat", () => {
  it("fills to capacity, then waitlists with positions 1, 2", async () => {
    const t = await makeTrip(c, { capacity: 2 });

    const b1 = await book(c, IDS.s1, t.id, IDS.loc.gate);
    const b2 = await book(c, IDS.s2, t.id, IDS.loc.carpark, "by the kiosk");
    expect(b1.status).toBe("confirmed");
    expect(b2.status).toBe("confirmed");
    expect(b1.waitlist_position).toBeNull();

    const b3 = await book(c, IDS.s3, t.id);
    const b4 = await book(c, IDS.admin, t.id);
    expect(b3.status).toBe("waitlisted");
    expect(b3.waitlist_position).toBe(1);
    expect(b4.status).toBe("waitlisted");
    expect(b4.waitlist_position).toBe(2);

    const after = await trip(c, t.id);
    expect(after.confirmed_count).toBe(2);
    expect(after.waitlist_count).toBe(2);
    await assertCountersConsistent(c, t.id);
  });

  it("rejects a second active booking with ALREADY_BOOKED", async () => {
    const t = await makeTrip(c, { capacity: 1 });
    await book(c, IDS.s1, t.id);
    const err = await errorOf(c, "select book_seat($1, $2)", [IDS.s1, t.id]);
    expect(err).toMatch(/^ALREADY_BOOKED:/);
    // waitlisted riders are also "already booked"
    await book(c, IDS.s2, t.id);
    const err2 = await errorOf(c, "select book_seat($1, $2)", [IDS.s2, t.id]);
    expect(err2).toMatch(/^ALREADY_BOOKED:/);
    await assertCountersConsistent(c, t.id);
  });

  it("raises BOOKING_CLOSED after the cutoff (5 min before departure)", async () => {
    const t = await makeTrip(c, { minutesFromNow: 3 });
    expect(t.status).toBe("boarding"); // within 15 min → boarding
    const err = await errorOf(c, "select book_seat($1, $2)", [IDS.s1, t.id]);
    expect(err).toMatch(/^BOOKING_CLOSED:/);
  });

  it("raises TRIP_NOT_OPEN on a cancelled trip and when bookings are disabled", async () => {
    const t = await makeTrip(c);
    await c.query("select set_trip_status($1, 'cancelled', $2, 'Bus broke down')", [t.id, IDS.admin]);
    const err = await errorOf(c, "select book_seat($1, $2)", [IDS.s1, t.id]);
    expect(err).toMatch(/^TRIP_NOT_OPEN:/);

    const t2 = await makeTrip(c);
    await c.query("update trips set bookings_enabled = false where id = $1", [t2.id]);
    const err2 = await errorOf(c, "select book_seat($1, $2)", [IDS.s1, t2.id]);
    expect(err2).toMatch(/^TRIP_NOT_OPEN:/);
  });

  it("raises PICKUP_INVALID for wrong-direction, inactive or unknown pickup points", async () => {
    const t = await makeTrip(c, { direction: "to_campus" });
    // KSB is a to_hostel point
    expect(await errorOf(c, "select book_seat($1, $2, $3)", [IDS.s1, t.id, IDS.loc.ksb])).toMatch(/^PICKUP_INVALID:/);
    // inactive point
    await c.query("update pickup_locations set is_active = false where id = $1", [IDS.loc.carpark]);
    expect(await errorOf(c, "select book_seat($1, $2, $3)", [IDS.s1, t.id, IDS.loc.carpark])).toMatch(/^PICKUP_INVALID:/);
    await c.query("update pickup_locations set is_active = true where id = $1", [IDS.loc.carpark]);
    // unknown id
    expect(
      await errorOf(c, "select book_seat($1, $2, $3)", [IDS.s1, t.id, "00000000-0000-4000-8000-000000000000"]),
    ).toMatch(/^PICKUP_INVALID:/);
    // a direction-less point works for both directions
    await c.query("update pickup_locations set direction = null where id = $1", [IDS.loc.commercial]);
    const b = await book(c, IDS.s1, t.id, IDS.loc.commercial);
    expect(b.status).toBe("confirmed");
    // nothing was booked by the failed attempts
    expect(await scalar<string>(c, "select count(*) from bookings where trip_id = $1", [t.id])).toBe("1");
  });

  it("re-uses the cancelled row when the same student books again", async () => {
    const t = await makeTrip(c);
    const b = await book(c, IDS.s1, t.id);
    await c.query("select cancel_booking($1, $2)", [IDS.s1, b.id]);
    const again = await book(c, IDS.s1, t.id, IDS.loc.gate);
    expect(again.id).toBe(b.id);
    expect(again.status).toBe("confirmed");
    expect(again.cancelled_at).toBeNull();
    expect(again.pickup_location_id).toBe(IDS.loc.gate);
    await assertCountersConsistent(c, t.id);
  });

  it("raises NOT_FOUND for an unknown trip and FORBIDDEN for a deactivated account", async () => {
    expect(await errorOf(c, "select book_seat($1, $2)", [IDS.s1, "00000000-0000-4000-8000-000000000000"])).toMatch(
      /^NOT_FOUND:/,
    );
    const t = await makeTrip(c);
    await c.query("update profiles set is_active = false where id = $1", [IDS.s3]);
    expect(await errorOf(c, "select book_seat($1, $2)", [IDS.s3, t.id])).toMatch(/^FORBIDDEN:/);
    await c.query("update profiles set is_active = true where id = $1", [IDS.s3]);
  });
});

describe("cancel_booking", () => {
  it("promotes the oldest waitlisted rider and renumbers the rest", async () => {
    const t = await makeTrip(c, { capacity: 1 });
    const b1 = await book(c, IDS.s1, t.id); // confirmed
    const b2 = await book(c, IDS.s2, t.id); // waitlist 1
    const b3 = await book(c, IDS.s3, t.id); // waitlist 2
    const b4 = await book(c, IDS.admin, t.id); // waitlist 3

    const result = await scalar<{ cancelled: BookingRow; promoted: BookingRow | null }>(
      c,
      "select cancel_booking($1, $2, 'self')",
      [IDS.s1, b1.id],
    );
    expect(result.cancelled.id).toBe(b1.id);
    expect(result.cancelled.status).toBe("cancelled");
    expect(result.promoted?.id).toBe(b2.id);
    expect(result.promoted?.status).toBe("confirmed");
    expect(result.promoted?.promoted_at).toBeTruthy();

    const positions = await rows<{ id: string; status: string; waitlist_position: number | null }>(
      c,
      "select id, status, waitlist_position from bookings where trip_id = $1 order by created_at",
      [t.id],
    );
    const byId = Object.fromEntries(positions.map((p) => [p.id, p]));
    expect(byId[b2.id]?.status).toBe("confirmed");
    expect(byId[b3.id]?.waitlist_position).toBe(1);
    expect(byId[b4.id]?.waitlist_position).toBe(2);
    await assertCountersConsistent(c, t.id);

    // cancelling a waitlisted rider renumbers too
    await c.query("select cancel_booking($1, $2)", [IDS.s3, b3.id]);
    expect(await scalar<number>(c, "select waitlist_position from bookings where id = $1", [b4.id])).toBe(1);
    await assertCountersConsistent(c, t.id);

    // idempotent
    const again = await scalar<{ cancelled: BookingRow; promoted: BookingRow | null }>(
      c,
      "select cancel_booking($1, $2)",
      [IDS.s3, b3.id],
    );
    expect(again.cancelled.status).toBe("cancelled");
    expect(again.promoted).toBeNull();
    await assertCountersConsistent(c, t.id);
  });

  it("is FORBIDDEN for another student but allowed for staff", async () => {
    const t = await makeTrip(c);
    const b = await book(c, IDS.s1, t.id);
    expect(await errorOf(c, "select cancel_booking($1, $2)", [IDS.s2, b.id])).toMatch(/^FORBIDDEN:/);
    expect(await errorOf(c, "select cancel_booking($1, $2, 'driver')", [IDS.driver, b.id])).toBe("");
    expect(await scalar<string>(c, "select status from bookings where id = $1", [b.id])).toBe("cancelled");
    expect(await errorOf(c, "select cancel_booking($1, $2)", [IDS.s1, "00000000-0000-4000-8000-000000000000"])).toMatch(
      /^NOT_FOUND:/,
    );
    await assertCountersConsistent(c, t.id);
  });
});

describe("set_booking_status / promote_waitlist", () => {
  it("keeps counters consistent across boarded / no_show / confirmed / cancelled", async () => {
    const t = await makeTrip(c, { capacity: 2 });
    const b1 = await book(c, IDS.s1, t.id);
    const b2 = await book(c, IDS.s2, t.id);
    const b3 = await book(c, IDS.s3, t.id); // waitlisted 1

    const boarded = await one<BookingRow>(c, "select * from set_booking_status($1, 'boarded', $2)", [b1.id, IDS.driver]);
    expect(boarded.status).toBe("boarded");
    expect(boarded.boarded_at).toBeTruthy();
    expect((await trip(c, t.id)).confirmed_count).toBe(2);
    await assertCountersConsistent(c, t.id);

    // no-show frees the seat but does not auto-promote
    const noShow = await one<BookingRow>(c, "select * from set_booking_status($1, 'no_show', $2)", [b2.id, IDS.driver]);
    expect(noShow.status).toBe("no_show");
    let tr = await trip(c, t.id);
    expect(tr.confirmed_count).toBe(1);
    expect(tr.waitlist_count).toBe(1);
    await assertCountersConsistent(c, t.id);

    // promote_waitlist fills the free seat
    const promoted = await rows<BookingRow>(c, "select * from promote_waitlist($1)", [t.id]);
    expect(promoted.map((p) => p.id)).toEqual([b3.id]);
    tr = await trip(c, t.id);
    expect(tr.confirmed_count).toBe(2);
    expect(tr.waitlist_count).toBe(0);
    await assertCountersConsistent(c, t.id);
    expect(await rows(c, "select * from promote_waitlist($1)", [t.id])).toHaveLength(0);

    // no_show → confirmed re-seats (over capacity is the driver's call)
    const reseated = await one<BookingRow>(c, "select * from set_booking_status($1, 'confirmed', $2)", [b2.id, IDS.driver]);
    expect(reseated.status).toBe("confirmed");
    expect((await trip(c, t.id)).confirmed_count).toBe(3);
    await assertCountersConsistent(c, t.id);

    // cancelled via set_booking_status delegates to cancel_booking
    const cancelled = await one<BookingRow>(c, "select * from set_booking_status($1, 'cancelled', $2)", [b1.id, IDS.driver]);
    expect(cancelled.status).toBe("cancelled");
    expect((await trip(c, t.id)).confirmed_count).toBe(2);
    await assertCountersConsistent(c, t.id);

    // undo boarding keeps the seat
    await c.query("select set_booking_status($1, 'boarded', $2)", [b3.id, IDS.driver]);
    await c.query("select set_booking_status($1, 'confirmed', $2)", [b3.id, IDS.driver]);
    expect((await trip(c, t.id)).confirmed_count).toBe(2);
    await assertCountersConsistent(c, t.id);

    // invalid transitions
    expect(await errorOf(c, "select set_booking_status($1, 'waitlisted')", [b3.id])).toMatch(/^CONFLICT:/);
    expect(await errorOf(c, "select set_booking_status($1, 'boarded')", [b1.id])).toMatch(/^CONFLICT:/);
    expect(await errorOf(c, "select set_booking_status($1, 'boarded')", ["00000000-0000-4000-8000-000000000000"])).toMatch(
      /^NOT_FOUND:/,
    );
  });

  it("boards a waitlisted rider directly and renumbers", async () => {
    const t = await makeTrip(c, { capacity: 1 });
    await book(c, IDS.s1, t.id);
    const w1 = await book(c, IDS.s2, t.id);
    const w2 = await book(c, IDS.s3, t.id);
    await c.query("select set_booking_status($1, 'boarded', $2)", [w1.id, IDS.driver]);
    const tr = await trip(c, t.id);
    expect(tr.confirmed_count).toBe(2);
    expect(tr.waitlist_count).toBe(1);
    expect(await scalar<number>(c, "select waitlist_position from bookings where id = $1", [w2.id])).toBe(1);
    await assertCountersConsistent(c, t.id);
  });

  it("promote_waitlist fills seats after a capacity increase, oldest first", async () => {
    const t = await makeTrip(c, { capacity: 1 });
    await book(c, IDS.s1, t.id);
    const w1 = await book(c, IDS.s2, t.id);
    const w2 = await book(c, IDS.s3, t.id);
    const w3 = await book(c, IDS.admin, t.id);
    await c.query("update trips set seat_capacity = 3 where id = $1", [t.id]);
    const promoted = await rows<BookingRow>(c, "select * from promote_waitlist($1)", [t.id]);
    expect(promoted.map((p) => p.id)).toEqual([w1.id, w2.id]);
    expect(await scalar<number>(c, "select waitlist_position from bookings where id = $1", [w3.id])).toBe(1);
    await assertCountersConsistent(c, t.id);
  });
});

describe("set_trip_status", () => {
  it("validates transitions, stamps timestamps and lets a driver claim the trip", async () => {
    const t = await makeTrip(c, { minutesFromNow: 60 });
    expect(t.status).toBe("scheduled");
    expect(t.driver_id).toBeNull();

    const boarding = await one<TripRow & { boarding_at: Date | null }>(
      c,
      "select * from set_trip_status($1, 'boarding', $2)",
      [t.id, IDS.driver],
    );
    expect(boarding.status).toBe("boarding");
    expect(boarding.boarding_at).toBeTruthy();
    expect(boarding.driver_id).toBe(IDS.driver);

    expect(await errorOf(c, "select set_trip_status($1, 'scheduled')", [t.id])).toMatch(/^CONFLICT:/);

    const departed = await one<TripRow & { departed_at: Date | null; bookings_enabled: boolean }>(
      c,
      "select * from set_trip_status($1, 'departed', $2)",
      [t.id, IDS.driver],
    );
    expect(departed.departed_at).toBeTruthy();
    expect(departed.bookings_enabled).toBe(false);

    const arrived = await one<TripRow & { arrived_at: Date | null }>(c, "select * from set_trip_status($1, 'arrived')", [t.id]);
    expect(arrived.arrived_at).toBeTruthy();
    expect(await errorOf(c, "select set_trip_status($1, 'cancelled')", [t.id])).toMatch(/^CONFLICT:/);

    const t2 = await makeTrip(c);
    const cancelled = await one<TripRow & { cancelled_at: Date | null; cancel_reason: string | null }>(
      c,
      "select * from set_trip_status($1, 'cancelled', $2, '  Driver unwell ')",
      [t2.id, IDS.admin],
    );
    expect(cancelled.cancelled_at).toBeTruthy();
    expect(cancelled.cancel_reason).toBe("Driver unwell");

    expect(await errorOf(c, "select set_trip_status($1, 'boarding')", ["00000000-0000-4000-8000-000000000000"])).toMatch(
      /^NOT_FOUND:/,
    );
  });
});
