/**
 * Shared helpers for the SQL test project (vitest --project sql).
 *
 * Every test file calls resetDb() in beforeAll: it drops + recreates the throwaway
 * local Postgres database (scripts/local-pg.sh reset applies pg-shims.sql and every
 * migration) and then applies supabase/seed.local.sql (admin, driver, 3 students).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client, type QueryResultRow } from "pg";

export const ROOT = path.resolve(__dirname, "../..");
export const DB_URL = process.env.TEST_DATABASE_URL || "postgres://postgres@127.0.0.1:54329/kharis_test";

/** Fixture ids from supabase/seed.local.sql */
export const IDS = {
  admin: "aaaaaaaa-0000-4000-8000-000000000001",
  driver: "dddddddd-0000-4000-8000-000000000001",
  s1: "55555555-0000-4000-8000-000000000001", // abena
  s2: "55555555-0000-4000-8000-000000000002", // yaw
  s3: "55555555-0000-4000-8000-000000000003", // efua
  loc: {
    gate: "11111111-0000-4000-8000-000000000001", // Hostel main gate (to_campus)
    carpark: "11111111-0000-4000-8000-000000000002", // Hostel car park (to_campus)
    ksb: "11111111-0000-4000-8000-000000000003", // KSB (to_hostel)
    commercial: "11111111-0000-4000-8000-000000000004", // Commercial Area (to_hostel)
  },
} as const;

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

/** Drop + recreate the database, apply shims + migrations, then the local fixtures. */
export async function resetDb(): Promise<Client> {
  execFileSync("bash", ["scripts/local-pg.sh", "reset"], { cwd: ROOT, stdio: "pipe" });
  const client = await connect();
  await client.query(readFileSync(path.join(ROOT, "supabase/seed.local.sql"), "utf8"));
  return client;
}

export async function rows<T extends QueryResultRow = QueryResultRow>(
  c: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await c.query<T>(sql, params);
  return r.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  c: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await rows<T>(c, sql, params);
  if (r.length !== 1) throw new Error(`expected exactly one row, got ${r.length} for: ${sql}`);
  return r[0] as T;
}

export async function scalar<T = unknown>(c: Client, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query(sql, params);
  const row = r.rows[0] as Record<string, T> | undefined;
  if (!row) throw new Error(`no row for: ${sql}`);
  const key = r.fields[0]?.name ?? Object.keys(row)[0]!;
  return row[key] as T;
}

/** Run `sql` and return the thrown error message ('' when it succeeded). */
export async function errorOf(c: Client, sql: string, params: unknown[] = []): Promise<string> {
  // Inside a transaction, probe under a savepoint so a failure does not abort it.
  let inTx = true;
  try {
    await c.query("savepoint err_probe");
  } catch {
    inTx = false; // "SAVEPOINT can only be used in transaction blocks"
  }
  try {
    await c.query(sql, params);
    if (inTx) await c.query("release savepoint err_probe");
    return "";
  } catch (e) {
    if (inTx) await c.query("rollback to savepoint err_probe");
    return (e as Error).message;
  }
}

export type Impersonation = {
  userId?: string | null;
  role?: "authenticated" | "anon" | "service_role";
  /** Keep the transaction (default: rollback so impersonated tests never leak state). */
  commit?: boolean;
  /** Only set the JWT claims, do not `set role` (simulates a superuser session with claims). */
  claimsOnly?: boolean;
};

/**
 * Impersonate the way PostgREST does: JWT claims via test_set_auth() + `set local role`.
 * Everything runs inside one transaction (rolled back by default).
 */
export async function as<T>(c: Client, opts: Impersonation, fn: (c: Client) => Promise<T>): Promise<T> {
  const role = opts.role ?? "authenticated";
  await c.query("begin");
  try {
    if (opts.userId) {
      await c.query("select public.test_set_auth($1::uuid, $2)", [opts.userId, role]);
    } else {
      await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', $2, true)", [
        JSON.stringify({ role }),
        role,
      ]);
    }
    if (!opts.claimsOnly) await c.query(`set local role ${role}`);
    const out = await fn(c);
    await c.query(opts.commit ? "commit" : "rollback");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}

/** Counter invariant: trips counters must equal the booking rows. */
export async function assertCountersConsistent(c: Client, tripId: string): Promise<void> {
  const r = await one<{
    confirmed_count: number;
    waitlist_count: number;
    actual_confirmed: string;
    actual_waitlisted: string;
    positions: number[] | null;
  }>(
    c,
    `select t.confirmed_count, t.waitlist_count,
            (select count(*) from bookings b where b.trip_id = t.id and b.status in ('confirmed','boarded')) as actual_confirmed,
            (select count(*) from bookings b where b.trip_id = t.id and b.status = 'waitlisted') as actual_waitlisted,
            (select array_agg(b.waitlist_position order by b.waitlist_position) from bookings b where b.trip_id = t.id and b.status = 'waitlisted') as positions
       from trips t where t.id = $1`,
    [tripId],
  );
  if (r.confirmed_count !== Number(r.actual_confirmed)) {
    throw new Error(`confirmed_count ${r.confirmed_count} != rows ${r.actual_confirmed}`);
  }
  if (r.waitlist_count !== Number(r.actual_waitlisted)) {
    throw new Error(`waitlist_count ${r.waitlist_count} != rows ${r.actual_waitlisted}`);
  }
  const expected = Array.from({ length: Number(r.actual_waitlisted) }, (_, i) => i + 1);
  const got = r.positions ?? [];
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`waitlist positions ${JSON.stringify(got)} != ${JSON.stringify(expected)}`);
  }
}

export type BookingRow = {
  id: string;
  trip_id: string;
  user_id: string;
  status: string;
  waitlist_position: number | null;
  pickup_location_id: string | null;
  cancelled_at: Date | null;
  promoted_at: Date | null;
  boarded_at: Date | null;
  created_at: Date;
};

export type TripRow = {
  id: string;
  status: string;
  seat_capacity: number;
  confirmed_count: number;
  waitlist_count: number;
  departure_at: Date;
  driver_id: string | null;
  reminder_at: Date | null;
  reminder_sent_at: Date | null;
  nudge_sent_at: Date | null;
  manifest_sent_at: Date | null;
  last_lat: number | null;
  last_lng: number | null;
  last_heading: number | null;
  last_speed_mps: number | null;
  last_location_at: Date | null;
};

/** Create an ad-hoc to_campus trip departing in `minutesFromNow` minutes. */
export async function makeTrip(
  c: Client,
  opts: { minutesFromNow?: number; capacity?: number; direction?: "to_campus" | "to_hostel"; driverId?: string | null } = {},
): Promise<TripRow> {
  const minutes = opts.minutesFromNow ?? 120;
  return one<TripRow>(
    c,
    `select * from create_adhoc_trip($1, 'Kharis Courts Hostel', 'KNUST', now() + make_interval(mins => $2), $3, $4, null)`,
    [opts.direction ?? "to_campus", minutes, opts.capacity ?? 2, opts.driverId ?? null],
  );
}

export async function book(
  c: Client,
  userId: string,
  tripId: string,
  pickupId: string | null = null,
  note: string | null = null,
): Promise<BookingRow> {
  return one<BookingRow>(c, "select * from book_seat($1, $2, $3, $4, 'self')", [userId, tripId, pickupId, note]);
}

export async function trip(c: Client, tripId: string): Promise<TripRow> {
  return one<TripRow>(c, "select * from trips where id = $1", [tripId]);
}

export async function tick(c: Client, at: string) {
  return one<{
    trips_created: number;
    daily_enqueued: number;
    reminders_enqueued: number;
    nudges_enqueued: number;
    manifests_enqueued: number;
    expired_trips: number;
    expired_requests: number;
    duration_ms: number | null;
    note: string | null;
  }>(c, "select * from run_tick($1::timestamptz)", [at]);
}
