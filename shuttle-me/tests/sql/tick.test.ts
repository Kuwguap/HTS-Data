/**
 * run_tick() replayed over the next Monday after today (Africa/Accra = UTC, no DST). The date is
 * computed, not hard-coded: book_seat() compares real now() with the departure cutoff, so a fixed
 * past date made the suite fail after 07:25 UTC on that day.
 * Seeded timetable: to_campus 07:30 09:30 11:30 13:30 15:30, to_hostel 12:30 14:30 16:30 18:30, Mon–Fri.
 * Settings: announcement 06:00, reminder lead 60, nudge 10, manifest lead 15, cutoff 5, 1 day ahead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { IDS, book, one, resetDb, rows, scalar, tick, type TripRow } from "./helpers";

let c: Client;

/** ISO date n days after an ISO date. */
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The next Monday strictly after today (UTC), so every departure is in the future for book_seat(). */
const MON = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
})();
const TUE = plusDays(MON, 1);
const WED = plusDays(MON, 2);
const THU = plusDays(MON, 3);
const at = (hhmm: string, date = MON) => `${date} ${hhmm}:00+00`;
/** Departure epoch seconds, as embedded in the per-trip dedupe prefixes. */
const epoch = (d: Date | string) => Math.round(new Date(d).getTime() / 1000);

type Notif = { user_id: string; kind: string; title: string; body: string; url: string | null; dedupe_key: string; data: Record<string, unknown> };

async function notifs(kind: string): Promise<Notif[]> {
  return rows<Notif>(c, "select user_id, kind, title, body, url, dedupe_key, data from notifications where kind = $1 order by created_at, user_id", [kind]);
}

async function tripAt(date: string, hhmm: string): Promise<TripRow> {
  return one<TripRow>(c, "select * from trips where departure_at = $1::timestamptz", [at(hhmm, date)]);
}

describe("run_tick — a normal Monday", () => {
  beforeAll(async () => {
    c = await resetDb();
  });
  afterAll(async () => {
    await c?.end();
  });

  it("materialises today + tomorrow once, even when run 50 times", async () => {
    const first = await tick(c, at("05:59"));
    expect(first.trips_created).toBe(18); // 9 slots × (Mon + Tue)
    expect(first.daily_enqueued).toBe(0);
    expect(first.note).toBe(`cleanup:${MON}`);

    for (let i = 0; i < 50; i++) {
      const r = await tick(c, at("05:59"));
      expect(r.trips_created).toBe(0);
      expect(r.daily_enqueued).toBe(0);
      expect(r.reminders_enqueued).toBe(0);
      expect(r.note).toBeNull(); // cleanup only once per date
    }
    expect(await scalar<string>(c, "select count(*) from trips")).toBe("18");
    expect(await scalar<string>(c, `select count(*) from trips where service_date = '${TUE}'`)).toBe("9");
    expect(await scalar<string>(c, "select count(*) from notifications")).toBe("0");
    expect(await scalar<string>(c, "select count(*) from tick_runs")).toBe("51");

    const t = await tripAt(MON, "07:30");
    expect(t.seat_capacity).toBe(14);
    expect(t.reminder_at?.toISOString()).toBe(new Date(at("06:30")).toISOString());
    const labels = await one<{ origin_label: string; destination_label: string }>(
      c,
      "select origin_label, destination_label from trips where id = $1",
      [t.id],
    );
    expect(labels).toEqual({ origin_label: "Kharis Courts Hostel", destination_label: "KNUST" });
    const back = await one<{ origin_label: string; destination_label: string }>(
      c,
      "select origin_label, destination_label from trips where departure_at = $1::timestamptz",
      [at("12:30")],
    );
    expect(back).toEqual({ origin_label: "KNUST", destination_label: "Kharis Courts Hostel" });
  });

  it("skips service_days_off", async () => {
    await c.query(`insert into service_days_off (service_date, reason) values ('${WED}', 'Holiday')`);
    const created = await scalar<number>(c, `select materialize_trips('${WED}', '${THU}')`);
    expect(created).toBe(9); // only Fri 30th
    expect(await scalar<string>(c, `select count(*) from trips where service_date = '${WED}'`)).toBe("0");
    await c.query(`delete from trips where service_date = '${THU}'`);
  });

  it("enqueues the daily announcement exactly once at 06:00 with the day's to_campus times", async () => {
    await c.query("update profiles set reminders_enabled = false where id = $1", [IDS.s3]);
    const r = await tick(c, at("06:00"));
    expect(r.daily_enqueued).toBe(2); // s1 + s2 (s3 opted out; driver/admin are not students)
    const again = await tick(c, at("06:05"));
    expect(again.daily_enqueued).toBe(0);

    const list = await notifs("daily_announcement");
    expect(list.map((n) => n.user_id).sort()).toEqual([IDS.s1, IDS.s2].sort());
    expect(list[0]?.body).toBe("Departures: 7:30 AM, 9:30 AM, 11:30 AM, 1:30 PM, 3:30 PM. Fare GH₵10, cash only. Tap to book your seat.");
    expect(list[0]?.dedupe_key).toBe(`daily:${MON}:${IDS.s1}`);
    expect(list[0]?.data["times"]).toBe("7:30 AM, 9:30 AM, 11:30 AM, 1:30 PM, 3:30 PM");
    expect(list[0]?.url).toBe("/app");
    await c.query("update profiles set reminders_enabled = true where id = $1", [IDS.s3]);
  });

  it("sends the 07:30 reminder at 06:30 once, only to students without a booking", async () => {
    const t = await tripAt(MON, "07:30");
    // s1 books before the reminder goes out (mock the clock: trip is in 2026, booking cutoff is fine)
    const b = await book(c, IDS.s1, t.id, IDS.loc.gate);
    expect(b.status).toBe("confirmed");

    const early = await tick(c, at("06:29"));
    expect(early.reminders_enqueued).toBe(0);

    const r = await tick(c, at("06:30"));
    expect(r.reminders_enqueued).toBe(2); // s2, s3
    const again = await tick(c, at("06:31"));
    expect(again.reminders_enqueued).toBe(0);

    const list = await notifs("trip_reminder");
    expect(list.map((n) => n.user_id).sort()).toEqual([IDS.s2, IDS.s3].sort());
    expect(list[0]?.title).toBe("🚌 Shuttle at 7:30 AM");
    expect(list[0]?.body).toBe("13/14 seats left. GH₵10 cash. Tap to opt in.");
    expect(list[0]?.url).toBe(`/app/trips/${t.id}`);
    expect(list[0]?.dedupe_key).toBe(`reminder:${t.id}:${epoch(at("07:30"))}:${IDS.s2}`);
    expect((await tripAt(MON, "07:30")).reminder_sent_at).toBeTruthy();
    // the 09:30 reminder is not due yet
    expect((await tripAt(MON, "09:30")).reminder_sent_at).toBeNull();
  });

  it("at 07:20 nudges only confirmed riders (with their pickup name) and sends the driver manifest", async () => {
    const t = await tripAt(MON, "07:30");
    await book(c, IDS.s2, t.id, IDS.loc.carpark);
    // s3 waitlisted: shrink capacity to 2 so the next booking waitlists
    await c.query("update trips set seat_capacity = 2 where id = $1", [t.id]);
    const w = await book(c, IDS.s3, t.id, IDS.loc.gate);
    expect(w.status).toBe("waitlisted");

    const before = await tick(c, at("07:14"));
    expect(before.nudges_enqueued).toBe(0);
    expect(before.manifests_enqueued).toBe(0);

    const r = await tick(c, at("07:20"));
    expect(r.nudges_enqueued).toBe(2);
    expect(r.manifests_enqueued).toBe(1);
    const again = await tick(c, at("07:21"));
    expect(again.nudges_enqueued).toBe(0);
    expect(again.manifests_enqueued).toBe(0);

    const nudges = await notifs("trip_nudge");
    const byUser = Object.fromEntries(nudges.map((n) => [n.user_id, n]));
    expect(Object.keys(byUser).sort()).toEqual([IDS.s1, IDS.s2].sort());
    expect(byUser[IDS.s1]?.title).toBe("⏰ Leaving in 10 min");
    expect(byUser[IDS.s1]?.body).toBe("Be at Hostel main gate. Have GH₵10 cash ready.");
    expect(byUser[IDS.s2]?.body).toBe("Be at Hostel car park. Have GH₵10 cash ready.");
    expect(byUser[IDS.s1]?.dedupe_key).toBe(`nudge:${t.id}:${epoch(at("07:30"))}:${IDS.s1}`);

    // no default driver and trip.driver_id null → every active driver (just kofi)
    const manifests = await notifs("driver_manifest");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.user_id).toBe(IDS.driver);
    expect(manifests[0]?.title).toBe("📋 7:30 AM to KNUST");
    expect(manifests[0]?.body).toBe("2 riders — Hostel car park ×1, Hostel main gate ×1");
    expect(manifests[0]?.url).toBe(`/driver/trips/${t.id}`);
    expect(await scalar<string>(c, "select urgency from notifications where id = (select id from notifications where kind = 'driver_manifest' limit 1)")).toBe("high");

    const after = await tripAt(MON, "07:30");
    expect(after.nudge_sent_at).toBeTruthy();
    expect(after.manifest_sent_at).toBeTruthy();
  });

  it("manifest goes to the assigned driver only when trips.driver_id is set", async () => {
    const t = await tripAt(MON, "09:30");
    await c.query("update trips set driver_id = $1 where id = $2", [IDS.admin, t.id]); // admin drives today
    const r = await tick(c, at("09:16"));
    expect(r.manifests_enqueued).toBe(1);
    const m = await one<Notif>(c, "select * from notifications where kind = 'driver_manifest' and dedupe_key like $1", [`manifest:${t.id}:%`]);
    expect(m.dedupe_key).toBe(`manifest:${t.id}:${epoch(at("09:30"))}:${IDS.admin}`);
    expect(m.user_id).toBe(IDS.admin);
    expect(m.body).toBe("0 riders — No bookings yet");
  });

  it("expires stale trips, auto-arrives long-departed trips and expires pickup requests", async () => {
    const t730 = await tripAt(MON, "07:30");
    const t930 = await tripAt(MON, "09:30");
    await c.query("select set_trip_status($1, 'departed', $2)", [t930.id, IDS.driver]);
    await c.query("update trips set departed_at = $1::timestamptz where id = $2", [at("09:31"), t930.id]);
    await c.query(
      `insert into pickup_requests (rider_id, trip_id, direction, pickup_location_id, expires_at)
       values ($1, $2, 'to_campus', $3, $4::timestamptz)`,
      [IDS.s3, t730.id, IDS.loc.gate, at("09:45")],
    );

    // 07:30 was already expired by the 09:16 tick above (07:30 + 90 min < 09:16).
    expect((await tripAt(MON, "07:30")).status).toBe("expired");

    const r = await tick(c, at("13:00"));
    // 09:30 departed > 3 h → arrived; 11:30 + 90 min = 13:00 is not yet strictly past
    expect(r.expired_trips).toBe(1);
    expect(r.expired_requests).toBe(1);
    expect((await tripAt(MON, "09:30")).status).toBe("arrived");
    expect((await tripAt(MON, "11:30")).status).toBe("scheduled");

    const next = await tick(c, at("13:01"));
    expect(next.expired_trips).toBe(1);
    expect((await tripAt(MON, "11:30")).status).toBe("expired");
    expect((await tripAt(MON, "12:30")).status).toBe("scheduled");
    expect((await tripAt(MON, "13:30")).status).toBe("scheduled");
    expect(await scalar<string>(c, "select status from pickup_requests limit 1")).toBe("expired");
    const expired = await notifs("pickup_request_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.user_id).toBe(IDS.s3);
    expect(expired[0]?.body).toContain("Hostel main gate");

    const again = await tick(c, at("13:02"));
    expect(again.expired_trips).toBe(0);
    expect(again.expired_requests).toBe(0);
  });
});

describe("run_tick — late first tick", () => {
  beforeAll(async () => {
    c = await resetDb();
  });
  afterAll(async () => {
    await c?.end();
  });

  it("never sends the 07:30 reminder when the first tick runs after departure − cutoff", async () => {
    const r = await tick(c, at("07:26")); // cutoff is 5 min → window closed at 07:25
    expect(r.trips_created).toBe(18);
    expect(r.reminders_enqueued).toBe(0);
    expect(await scalar<string>(c, "select count(*) from notifications where kind = 'trip_reminder'")).toBe("0");
    const t = await tripAt(MON, "07:30");
    expect(t.reminder_sent_at).toBeTruthy(); // closed silently
    expect((await tripAt(MON, "09:30")).reminder_sent_at).toBeNull();
    // the announcement window (06:00–08:00) is still open → it does go out
    expect(r.daily_enqueued).toBe(3);
    // nudge + manifest for 07:30 are in their windows at 07:26
    expect(r.manifests_enqueued).toBe(1);
    expect(r.nudges_enqueued).toBe(0); // nobody booked
  });

  it("skips the daily announcement when the first tick of the day is more than 2 h late", async () => {
    const r = await tick(c, at("08:01", TUE));
    expect(r.daily_enqueued).toBe(0);
    expect(await scalar<string>(c, `select count(*) from notifications where kind = 'daily_announcement' and dedupe_key like 'daily:${TUE}:%'`)).toBe("0");
    const later = await tick(c, at("09:00", TUE));
    expect(later.daily_enqueued).toBe(0);
  });

  it("respects daily_announcement_enabled = false", async () => {
    await c.query("update settings set daily_announcement_enabled = false where id = 1");
    const r = await tick(c, at("06:00", WED));
    expect(r.daily_enqueued).toBe(0);
    await c.query("update settings set daily_announcement_enabled = true where id = 1");
  });
});

describe("run_tick — reminder lead follows settings", () => {
  beforeAll(async () => {
    c = await resetDb();
  });
  afterAll(async () => {
    await c?.end();
  });

  it("uses the CURRENT reminder_lead_minutes for scheduled trips, not the materialised reminder_at", async () => {
    const first = await tick(c, at("05:59"));
    expect(first.trips_created).toBe(18);
    const t = await tripAt(MON, "07:30");
    expect(t.reminder_at?.toISOString()).toBe(new Date(at("06:30")).toISOString()); // lead 60 at materialisation

    await c.query("update settings set reminder_lead_minutes = 30 where id = 1");

    // 06:35 is past the old (frozen) 06:30 moment but before the new 07:00 one → nothing
    const early = await tick(c, at("06:35"));
    expect(early.reminders_enqueued).toBe(0);
    expect((await tripAt(MON, "07:30")).reminder_sent_at).toBeNull();
    expect(await scalar<string>(c, "select count(*) from notifications where kind = 'trip_reminder'")).toBe("0");

    const due = await tick(c, at("07:00"));
    expect(due.reminders_enqueued).toBe(3); // s1, s2, s3 — nobody booked
    const after = await tripAt(MON, "07:30");
    expect(after.reminder_sent_at).toBeTruthy();
    expect(after.reminder_at?.toISOString()).toBe(new Date(at("07:00")).toISOString()); // audit value refreshed
    expect(await scalar<string>(c, "select count(*) from notifications where kind = 'trip_reminder'")).toBe("3");
    // the 09:30 trip is now due at 09:00, not 08:30
    expect((await tick(c, at("08:31"))).reminders_enqueued).toBe(0);
    expect((await tick(c, at("09:00"))).reminders_enqueued).toBe(3);
  });

  it("ad-hoc trips keep using their own reminder_at (null = no reminder)", async () => {
    const adhoc = await one<TripRow>(
      c,
      `select * from create_adhoc_trip('to_hostel', 'KSB', 'Kharis Courts Hostel', $1::timestamptz, 10, null, null)`,
      [at("17:00")],
    );
    expect(adhoc.reminder_at?.toISOString()).toBe(new Date(at("16:30")).toISOString()); // lead is 30 now
    // lower the lead again: the ad-hoc trip's moment stays 16:30, so 16:30 fires it
    await c.query("update settings set reminder_lead_minutes = 5 where id = 1");
    expect((await tick(c, at("16:29"))).reminders_enqueued).toBe(0);
    expect((await tick(c, at("16:30"))).reminders_enqueued).toBe(3);
    expect(await scalar<string>(c, "select count(*) from notifications where dedupe_key like $1", [`reminder:${adhoc.id}:%`])).toBe("3");

    const silent = await one<TripRow>(
      c,
      `select * from create_adhoc_trip('to_hostel', 'KSB', 'Kharis Courts Hostel', $1::timestamptz, 10, null, null)`,
      [at("19:00")],
    );
    await c.query("update trips set reminder_at = null where id = $1", [silent.id]);
    const r = await tick(c, at("18:56"));
    expect(await scalar<string>(c, "select count(*) from notifications where dedupe_key like $1", [`reminder:${silent.id}:%`])).toBe("0");
    expect(r.reminders_enqueued).toBe(0);
  });
});

describe("run_tick — admin edits", () => {
  beforeAll(async () => {
    c = await resetDb();
  });
  afterAll(async () => {
    await c?.end();
  });

  it("treats the manual tick's 'cleanup:<date> manual' note as that day's cleanup marker", async () => {
    await c.query("insert into tick_runs (now_ts, note) values ($1::timestamptz, $2)", [at("05:58"), `cleanup:${MON} manual`]);
    const r = await tick(c, at("05:59"));
    expect(r.note).toBeNull(); // cleanup already done today → no second marker
    expect(await scalar<string>(c, "select count(*) from tick_runs where note like $1", [`cleanup:${MON}%`])).toBe("1");
  });

  it("re-sends a reminder exactly once when departure_at moves and reminder_sent_at is reset", async () => {
    const t = await tripAt(MON, "07:30");
    const sent = await tick(c, at("06:30"));
    expect(sent.reminders_enqueued).toBe(3); // nobody booked
    const oldKeys = (await notifs("trip_reminder")).map((n) => n.dedupe_key);
    expect(oldKeys).toHaveLength(3);
    expect(oldKeys.every((k) => k.startsWith(`reminder:${t.id}:${epoch(at("07:30"))}:`))).toBe(true);

    // admin moves the trip an hour later and asks for the reminder again
    await c.query("update trips set departure_at = $1::timestamptz, reminder_sent_at = null where id = $2", [at("08:30"), t.id]);
    expect((await tick(c, at("06:31"))).reminders_enqueued).toBe(0); // new moment is 07:30
    expect((await tripAt(MON, "08:30")).reminder_sent_at).toBeNull();

    const resent = await tick(c, at("07:30"));
    expect(resent.reminders_enqueued).toBe(3);
    expect((await tick(c, at("07:31"))).reminders_enqueued).toBe(0);

    const all = await notifs("trip_reminder");
    expect(all).toHaveLength(6);
    const newKeys = all.map((n) => n.dedupe_key).filter((k) => !oldKeys.includes(k));
    expect(newKeys).toHaveLength(3);
    expect(newKeys.every((k) => k.startsWith(`reminder:${t.id}:${epoch(at("08:30"))}:`))).toBe(true);
    expect(newKeys.map((k) => k.split(":").pop()).sort()).toEqual([IDS.s1, IDS.s2, IDS.s3].sort());

    // a bare flag reset WITHOUT a time change cannot double-send (same key)
    await c.query("update trips set reminder_sent_at = null where id = $1", [t.id]);
    expect((await tick(c, at("07:32"))).reminders_enqueued).toBe(0);
    expect((await tripAt(MON, "08:30")).reminder_sent_at).toBeTruthy();
    expect(await scalar<string>(c, "select count(*) from notifications where kind = 'trip_reminder'")).toBe("6");
  });

  it("writes a plain 'cleanup:<date>' marker on the next local date", async () => {
    const tue = await tick(c, at("00:01", TUE));
    expect(tue.note).toBe(`cleanup:${TUE}`);
    expect((await tick(c, at("00:02", TUE))).note).toBeNull();
  });
});

describe("timezone", () => {
  beforeAll(async () => {
    c = await resetDb();
  });
  afterAll(async () => {
    await c?.end();
  });

  it("materialises 07:30 local as 06:30Z under Africa/Lagos", async () => {
    await c.query("update settings set timezone = 'Africa/Lagos' where id = 1");
    const created = await scalar<number>(c, "select materialize_trips('2026-11-02', '2026-11-02')");
    expect(created).toBe(9);
    const t = await one<TripRow>(c, "select * from trips where service_date = '2026-11-02' and direction = 'to_campus' order by departure_at limit 1");
    expect(t.departure_at.toISOString()).toBe("2026-11-02T06:30:00.000Z");
    expect(t.reminder_at?.toISOString()).toBe("2026-11-02T05:30:00.000Z");
    expect(await scalar<string>(c, "select format_local_time($1::timestamptz)", [t.departure_at])).toBe("7:30 AM");
    expect(await scalar<string>(c, "select local_now('2026-11-02 06:30:00+00')::text")).toBe("2026-11-02 07:30:00");
    // the daily announcement window follows the zone: 06:00 Lagos = 05:00Z
    const r = await tick(c, "2026-11-02 05:00:00+00");
    expect(r.daily_enqueued).toBe(3);
    await c.query("update settings set timezone = 'Africa/Accra' where id = 1");
  });
});

describe("run_tick — announced ad-hoc to_hostel trips", () => {
  // create_adhoc_trip works off the real clock (reminder_at = departure − lead when the lead
  // has not passed), so these cases use now() and tick at the trip's own reminder_at.
  beforeAll(async () => {
    c = await resetDb();
  });
  afterAll(async () => {
    await c?.end();
  });

  async function announcedTrip(): Promise<TripRow> {
    const t = await one<TripRow>(
      c,
      `select * from create_adhoc_trip('to_hostel', 'KSB', 'Kharis Courts Hostel', now() + interval '90 minutes', 10, $1, $1)`,
      [IDS.driver],
    );
    expect(t.reminder_at).not.toBeNull(); // lead 60 < 90 → the tick would remind
    expect(t.reminder_sent_at).toBeNull();
    return t;
  }
  const remindersFor = (tripId: string) =>
    scalar<string>(c, "select count(*) from notifications where kind = 'trip_reminder' and data->>'trip_id' = $1", [tripId]);
  /** reminder_at carries microseconds; a JS Date truncates them, so tick one second later. */
  const reminderTick = (t: TripRow, plusMs = 0) => new Date(t.reminder_at!.getTime() + 1000 + plusMs).toISOString();

  it("control: without the route's stamp the tick ALSO pushes trip_reminder for the announced trip", async () => {
    const t = await announcedTrip();
    await tick(c, reminderTick(t));
    expect(await remindersFor(t.id)).toBe("3"); // every student without a booking
    expect((await one<TripRow>(c, "select * from trips where id = $1", [t.id])).reminder_sent_at).toBeTruthy();
  });

  it("the announce / admin routes stamp reminder_sent_at after create_adhoc_trip, so the tick stays silent", async () => {
    const t = await announcedTrip();
    // exactly what POST /api/driver/announce and POST /api/admin/trips (notify, to_hostel) do
    await c.query("update trips set reminder_sent_at = now() where id = $1 and reminder_sent_at is null", [t.id]);
    const r = await tick(c, reminderTick(t));
    expect(await remindersFor(t.id)).toBe("0");
    // and a later tick inside the window does not catch up either
    await tick(c, reminderTick(t, 5 * 60_000));
    expect(await remindersFor(t.id)).toBe("0");
    expect(r.expired_trips).toBe(0);
  });
});
