import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { IDS, as, makeTrip, resetDb, rows, scalar, trip } from "./helpers";

let c: Client;

beforeAll(async () => {
  c = await resetDb();
});

afterAll(async () => {
  await c?.end();
});

type Msg = { topic: string; extension: string; event: string; payload: Record<string, unknown>; private: boolean };

describe("trip_locations trigger", () => {
  it("broadcasts on trip:<id> and updates trips.last_* with the newest fix", async () => {
    const t = await makeTrip(c, { minutesFromNow: 5 });
    await c.query(
      `insert into trip_locations (trip_id, driver_id, lat, lng, accuracy_m, heading, speed_mps, recorded_at)
       values ($1, $2, 6.6760, -1.5720, 12.5, 90, 4.2, '2026-10-27 07:31:00+00')`,
      [t.id, IDS.driver],
    );
    const msgs = await rows<Msg>(c, "select topic, extension, event, payload, private from realtime.messages order by id");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ topic: `trip:${t.id}`, extension: "broadcast", event: "location", private: true });
    expect(msgs[0]?.payload).toEqual({
      trip_id: t.id,
      lat: 6.676,
      lng: -1.572,
      heading: 90,
      speed_mps: 4.2,
      accuracy_m: 12.5,
      recorded_at: "2026-10-27T07:31:00+00:00",
    });

    let tr = await trip(c, t.id);
    expect(tr.last_lat).toBe(6.676);
    expect(tr.last_lng).toBe(-1.572);
    expect(tr.last_heading).toBe(90);
    expect(tr.last_speed_mps).toBe(4.2);
    expect(tr.last_location_at?.toISOString()).toBe("2026-10-27T07:31:00.000Z");

    // an older fix arriving late (batched upload) must not move the bus backwards
    await c.query(
      `insert into trip_locations (trip_id, driver_id, lat, lng, recorded_at) values ($1, $2, 6.0, -1.0, '2026-10-27 07:30:00+00')`,
      [t.id, IDS.driver],
    );
    tr = await trip(c, t.id);
    expect(tr.last_lat).toBe(6.676);
    expect(tr.last_location_at?.toISOString()).toBe("2026-10-27T07:31:00.000Z");
    expect(await scalar<string>(c, "select count(*) from realtime.messages")).toBe("2"); // still broadcast (trail)

    // a newer fix moves it forward
    await c.query(
      `insert into trip_locations (trip_id, driver_id, lat, lng, recorded_at) values ($1, $2, 6.70, -1.60, '2026-10-27 07:32:00+00')`,
      [t.id, IDS.driver],
    );
    tr = await trip(c, t.id);
    expect(tr.last_lat).toBe(6.7);
    expect(tr.last_heading).toBeNull();
  });

  it("refreshes trips.last_* at most every 15 s (recorded_at based) but broadcasts every fix", async () => {
    const t = await makeTrip(c, { minutesFromNow: 5 });
    const fix = (lat: number, recordedAt: string) =>
      c.query(`insert into trip_locations (trip_id, driver_id, lat, lng, recorded_at) values ($1, $2, $3, -1.5, $4::timestamptz)`, [
        t.id,
        IDS.driver,
        lat,
        recordedAt,
      ]);
    const broadcasts = () => scalar<string>(c, "select count(*) from realtime.messages where topic = $1", [`trip:${t.id}`]);

    await fix(6.1, "2026-10-27 08:00:00+00");
    let tr = await trip(c, t.id);
    expect(tr.last_lat).toBe(6.1);
    expect(tr.last_location_at?.toISOString()).toBe("2026-10-27T08:00:00.000Z");

    // 5 s later: row + broadcast written, trips.last_* untouched
    await fix(6.2, "2026-10-27 08:00:05+00");
    tr = await trip(c, t.id);
    expect(tr.last_lat).toBe(6.1);
    expect(tr.last_location_at?.toISOString()).toBe("2026-10-27T08:00:00.000Z");
    expect(await broadcasts()).toBe("2");

    // 16 s after the last accepted fix: trips.last_* moves
    await fix(6.3, "2026-10-27 08:00:16+00");
    tr = await trip(c, t.id);
    expect(tr.last_lat).toBe(6.3);
    expect(tr.last_location_at?.toISOString()).toBe("2026-10-27T08:00:16.000Z");
    expect(await broadcasts()).toBe("3");
    expect(await scalar<string>(c, "select count(*) from trip_locations where trip_id = $1", [t.id])).toBe("3");
  });

  it("still inserts the fix when the broadcast fails", async () => {
    const t = await makeTrip(c, { minutesFromNow: 5 });
    await c.query("begin");
    await c.query("alter function realtime.send(jsonb, text, text, boolean) rename to send_broken");
    await c.query(`insert into trip_locations (trip_id, lat, lng, recorded_at) values ($1, 6.1, -1.1, now())`, [t.id]);
    expect(await scalar<string>(c, "select count(*) from trip_locations where trip_id = $1", [t.id])).toBe("1");
    expect((await trip(c, t.id)).last_lat).toBe(6.1);
    await c.query("rollback");
  });
});

describe("realtime.messages policy", () => {
  it("lets authenticated users read broadcast rows for trip:% topics only", async () => {
    const t = await makeTrip(c, { minutesFromNow: 5 });
    await c.query(`insert into trip_locations (trip_id, lat, lng, recorded_at) values ($1, 6.2, -1.2, now())`, [t.id]);
    await c.query(`insert into realtime.messages (topic, extension, event, payload) values ('room:secret', 'broadcast', 'x', '{}')`);

    const visible = await as(c, { userId: IDS.s1 }, async (cx) => {
      await cx.query("select set_config('realtime.topic', $1, true)", [`trip:${t.id}`]);
      return rows<{ topic: string }>(cx, "select topic from realtime.messages");
    });
    // The policy authorises the *channel* being joined (realtime.topic()), as on Supabase.
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.some((m) => m.topic === `trip:${t.id}`)).toBe(true);

    const hidden = await as(c, { userId: IDS.s1 }, async (cx) => {
      await cx.query("select set_config('realtime.topic', 'room:secret', true)");
      return rows(cx, "select topic from realtime.messages");
    });
    expect(hidden).toHaveLength(0);
  });
});

describe("publication", () => {
  it("adds the four signal tables only when supabase_realtime exists", async () => {
    // Locally there is no publication → nothing to add, migration must still have applied.
    expect(await scalar<string>(c, "select count(*) from pg_publication where pubname = 'supabase_realtime'")).toBe("0");
    const ri = await rows<{ relname: string; relreplident: string }>(
      c,
      "select relname, relreplident from pg_class where relname in ('trips', 'bookings', 'pickup_requests', 'notifications') order by relname",
    );
    expect(ri).toEqual([
      { relname: "bookings", relreplident: "f" },
      { relname: "notifications", relreplident: "f" },
      { relname: "pickup_requests", relreplident: "f" },
      { relname: "trips", relreplident: "f" },
    ]);
  });
});
