/**
 * RLS matrix. Impersonation = JWT claims via test_set_auth() + `set local role`, which is
 * exactly what PostgREST does. The postgres superuser (no claims) and service_role
 * (bypassrls) see everything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { IDS, as, book, errorOf, makeTrip, one, resetDb, rows, scalar } from "./helpers";

let c: Client;
let tripId: string;

beforeAll(async () => {
  c = await resetDb();
  const t = await makeTrip(c, { capacity: 5 });
  tripId = t.id;
  await book(c, IDS.s1, t.id, IDS.loc.gate);
  await book(c, IDS.s2, t.id, IDS.loc.carpark);
  await c.query(`select enqueue_notification(array[$1, $2]::uuid[], 'test', '{"name":"x"}', null, 'rls:test')`, [IDS.s1, IDS.s2]);
  await c.query(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example/s1', 'k', 'a'), ($2, 'https://push.example/s2', 'k', 'a')`,
    [IDS.s1, IDS.s2],
  );
  await c.query(
    `insert into pickup_requests (rider_id, trip_id, direction, custom_place) values ($1, $2, 'to_campus', 'Behind the bank'), ($3, $2, 'to_campus', 'Taxi rank')`,
    [IDS.s1, tripId, IDS.s2],
  );
  await c.query(`insert into trip_locations (trip_id, driver_id, lat, lng, recorded_at) values ($1, $2, 6.6, -1.5, now())`, [tripId, IDS.driver]);
  await c.query("insert into login_attempts (username, failed_count) values ('abena', 2)");
});

afterAll(async () => {
  await c?.end();
});

const count = (cx: Client, table: string) => scalar<string>(cx, `select count(*) from ${table}`);

describe("student", () => {
  it("sees only their own bookings, notifications and pickup requests", async () => {
    await as(c, { userId: IDS.s1 }, async (cx) => {
      const b = await rows<{ user_id: string }>(cx, "select user_id from bookings");
      expect(b).toHaveLength(1);
      expect(b[0]?.user_id).toBe(IDS.s1);
      const n = await rows<{ user_id: string }>(cx, "select user_id from notifications");
      expect(n).toHaveLength(1);
      expect(n[0]?.user_id).toBe(IDS.s1);
      const r = await rows<{ rider_id: string }>(cx, "select rider_id from pickup_requests");
      expect(r).toHaveLength(1);
      expect(r[0]?.rider_id).toBe(IDS.s1);
    });
  });

  it("sees only their own profile; reference data and recent trips are visible", async () => {
    await as(c, { userId: IDS.s1 }, async (cx) => {
      const p = await rows<{ id: string }>(cx, "select id from profiles");
      expect(p.map((x) => x.id)).toEqual([IDS.s1]);
      expect(await count(cx, "settings")).toBe("1");
      expect(await count(cx, "pickup_locations")).toBe("4");
      expect(await count(cx, "schedule_times")).toBe("9");
      expect(await count(cx, "trips")).toBe("1");
      expect(await count(cx, "trip_locations")).toBe("1");
      // admin-only tables are empty for students
      expect(await count(cx, "message_templates")).toBe("0");
      expect(await count(cx, "tick_runs")).toBe("0");
    });
  });

  it("can read public settings columns but not signup_code / default_driver_id / updated_by", async () => {
    await c.query("update settings set signup_code = 'KC-2026' where id = 1");
    await as(c, { userId: IDS.s1 }, async (cx) => {
      expect(await scalar<string>(cx, "select hostel_name from settings")).toBe("Kharis Courts Hostel");
      const ok = await one<{ fare_pesewas: number; timezone: string; booking_cutoff_minutes: number }>(
        cx,
        "select fare_pesewas, timezone, booking_cutoff_minutes from settings where id = 1",
      );
      expect(ok).toEqual({ fare_pesewas: 1000, timezone: "Africa/Accra", booking_cutoff_minutes: 5 });
      expect(await errorOf(cx, "select signup_code from settings")).toMatch(/permission denied/);
      expect(await errorOf(cx, "select default_driver_id from settings")).toMatch(/permission denied/);
      expect(await errorOf(cx, "select updated_by from settings")).toMatch(/permission denied/);
      expect(await errorOf(cx, "select * from settings")).toMatch(/permission denied/);
      // using the column in a predicate is a read too
      expect(await errorOf(cx, "select id from settings where signup_code = 'KC-2026'")).toMatch(/permission denied/);
    });
    // staff are clients too: same column restriction
    await as(c, { userId: IDS.admin }, async (cx) => {
      expect(await errorOf(cx, "select signup_code from settings")).toMatch(/permission denied/);
    });
    // the service role sees it
    await as(c, { role: "service_role" }, async (cx) => {
      expect(await scalar<string>(cx, "select signup_code from settings")).toBe("KC-2026");
    });
    await c.query("update settings set signup_code = null where id = 1");
  });

  it("cannot read push_subscriptions or login_attempts at all", async () => {
    await as(c, { userId: IDS.s1 }, async (cx) => {
      expect(await errorOf(cx, "select * from push_subscriptions")).toMatch(/permission denied/);
      expect(await errorOf(cx, "select * from login_attempts")).toMatch(/permission denied/);
    });
  });

  it("cannot write bookings, trips or notifications directly", async () => {
    await as(c, { userId: IDS.s1 }, async (cx) => {
      expect(await errorOf(cx, "insert into bookings (trip_id, user_id, status) values ($1, $2, 'confirmed')", [tripId, IDS.s3])).toMatch(/permission denied/);
      expect(await errorOf(cx, "update trips set seat_capacity = 99")).toMatch(/permission denied/);
      expect(await errorOf(cx, "update notifications set read_at = now()")).toMatch(/permission denied/);
      expect(await errorOf(cx, "delete from bookings")).toMatch(/permission denied/);
    });
  });

  it("can update their own phone but not someone else's", async () => {
    await as(c, { userId: IDS.s1, commit: true }, async (cx) => {
      const r = await cx.query("update profiles set phone = '+233555000111' where id = $1", [IDS.s1]);
      expect(r.rowCount).toBe(1);
      const other = await cx.query("update profiles set phone = 'hacked' where id = $1", [IDS.s2]);
      expect(other.rowCount).toBe(0);
    });
    expect(await scalar<string>(c, "select phone from profiles where id = $1", [IDS.s1])).toBe("+233555000111");
    expect(await scalar<string>(c, "select phone from profiles where id = $1", [IDS.s2])).toBeNull();
  });

  it("cannot change their own role or is_active (column grant + trigger)", async () => {
    // As the authenticated role: no column privilege at all.
    await as(c, { userId: IDS.s1 }, async (cx) => {
      expect(await errorOf(cx, "update profiles set role = 'admin' where id = $1", [IDS.s1])).toMatch(/permission denied/);
      expect(await errorOf(cx, "update profiles set is_active = false where id = $1", [IDS.s1])).toMatch(/permission denied/);
    });
    // Even with full table privileges, a JWT role of `authenticated` is stopped by the trigger.
    await as(c, { userId: IDS.s1, claimsOnly: true }, async (cx) => {
      expect(await errorOf(cx, "update profiles set role = 'admin' where id = $1", [IDS.s1])).toMatch(/^FORBIDDEN:/);
      expect(await errorOf(cx, "update profiles set is_active = false where id = $1", [IDS.s1])).toMatch(/^FORBIDDEN:/);
      expect(await errorOf(cx, "update profiles set room = 'A1' where id = $1", [IDS.s1])).toBe("");
    });
    expect(await scalar<string>(c, "select role from profiles where id = $1", [IDS.s1])).toBe("student");
    // The service role (and a plain superuser session) may.
    await as(c, { userId: IDS.admin, role: "service_role", claimsOnly: true }, async (cx) => {
      expect(await errorOf(cx, "update profiles set role = 'driver' where id = $1", [IDS.s3])).toBe("");
    });
    expect(await errorOf(c, "update profiles set role = 'driver' where id = $1", [IDS.s3])).toBe("");
    await c.query("update profiles set role = 'student' where id = $1", [IDS.s3]);
  });

  it("mark_notifications_read only touches their own rows", async () => {
    const ids = await rows<{ id: string; user_id: string }>(c, "select id, user_id from notifications");
    await as(c, { userId: IDS.s1, commit: true }, async (cx) => {
      await cx.query("select mark_notifications_read($1::uuid[])", [ids.map((n) => n.id)]);
    });
    const after = await rows<{ user_id: string; read_at: Date | null }>(c, "select user_id, read_at from notifications");
    expect(after.find((n) => n.user_id === IDS.s1)?.read_at).toBeTruthy();
    expect(after.find((n) => n.user_id === IDS.s2)?.read_at).toBeNull();
  });

  it("can see old trips they booked, but not other old trips", async () => {
    const old = await makeTrip(c, { minutesFromNow: 120 });
    const mine = await makeTrip(c, { minutesFromNow: 120 });
    await book(c, IDS.s1, mine.id);
    await c.query("update trips set service_date = '2026-01-05' where id = any($1::uuid[])", [[old.id, mine.id]]);
    await as(c, { userId: IDS.s1 }, async (cx) => {
      const ids = (await rows<{ id: string }>(cx, "select id from trips")).map((t) => t.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(old.id);
    });
    await as(c, { userId: IDS.driver }, async (cx) => {
      const ids = (await rows<{ id: string }>(cx, "select id from trips")).map((t) => t.id);
      expect(ids).toContain(old.id);
    });
    await c.query("delete from trips where id = any($1::uuid[])", [[old.id, mine.id]]);
  });
});

describe("driver and admin", () => {
  it("driver sees all bookings, pickup requests and profiles; still not templates", async () => {
    await as(c, { userId: IDS.driver }, async (cx) => {
      expect(await count(cx, "bookings")).toBe("2");
      expect(await count(cx, "pickup_requests")).toBe("2");
      expect(await count(cx, "profiles")).toBe("5");
      expect(await count(cx, "notifications")).toBe("0"); // own only, none for the driver
      expect(await count(cx, "message_templates")).toBe("0");
      expect(await scalar<string>(cx, "select my_role()")).toBe("driver");
    });
  });

  it("admin sees templates and tick runs", async () => {
    await c.query("select run_tick(now())");
    await as(c, { userId: IDS.admin }, async (cx) => {
      expect(await count(cx, "message_templates")).toBe("19");
      expect(Number(await count(cx, "tick_runs"))).toBeGreaterThan(0);
      expect(await scalar<string>(cx, "select my_role()")).toBe("admin");
    });
  });

  it("a deactivated driver loses staff visibility", async () => {
    await c.query("update profiles set is_active = false where id = $1", [IDS.driver]);
    await as(c, { userId: IDS.driver }, async (cx) => {
      expect(await scalar<string | null>(cx, "select my_role()")).toBeNull();
      expect(await count(cx, "bookings")).toBe("0");
    });
    await c.query("update profiles set is_active = true where id = $1", [IDS.driver]);
  });
});

describe("service_role and anon", () => {
  it("service_role bypasses RLS entirely", async () => {
    await as(c, { role: "service_role" }, async (cx) => {
      expect(await count(cx, "bookings")).toBe("2");
      expect(await count(cx, "push_subscriptions")).toBe("2");
      expect(await count(cx, "login_attempts")).toBe("1");
      expect(await count(cx, "notifications")).toBe("2");
      expect(await errorOf(cx, "select run_tick()")).toBe("");
      expect(await errorOf(cx, "select book_seat($1, $2)", [IDS.s3, tripId])).toBe("");
    });
  });

  it("anon can read nothing", async () => {
    await as(c, { role: "anon" }, async (cx) => {
      for (const t of ["trips", "settings", "schedule_times", "profiles", "bookings", "notifications"]) {
        expect(await errorOf(cx, `select * from ${t}`)).toMatch(/permission denied/);
      }
      expect(await errorOf(cx, "select my_role()")).toMatch(/permission denied/);
    });
  });

  it("profiles are created by the auth.users trigger with role from app_metadata only", async () => {
    await c.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
       ('99999999-0000-4000-8000-000000000001', 'kwame@users.kharis-shuttle.local', '{"username":"Kwame","full_name":"Kwame A","role":"admin"}', '{}')`,
    );
    const p = await one<{ username: string; role: string; full_name: string }>(
      c,
      "select username, role, full_name from profiles where id = '99999999-0000-4000-8000-000000000001'",
    );
    expect(p).toEqual({ username: "kwame", role: "student", full_name: "Kwame A" });
    // bad usernames are rejected by the check constraint (→ the auth insert fails)
    expect(
      await errorOf(
        c,
        `insert into auth.users (email, raw_user_meta_data) values ('x@users.kharis-shuttle.local', '{"username":"no spaces!"}')`,
      ),
    ).toMatch(/profiles_username_format/);
    // duplicate username → unique violation
    expect(
      await errorOf(c, `insert into auth.users (email, raw_user_meta_data) values ('abena2@users.kharis-shuttle.local', '{"username":"abena"}')`),
    ).toMatch(/profiles_username_key/);
  });
});
