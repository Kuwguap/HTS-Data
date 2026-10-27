# Supabase schema — Kharis Shuttle

Everything the database does lives in `supabase/migrations/*.sql`. The same files apply
to the hosted Supabase project and to a plain local Postgres 16 (`scripts/local-pg.sh`,
which runs `scripts/pg-shims.sql` first to fake the Supabase roles, `auth.*` and
`realtime.send`). The TypeScript contract is `src/lib/db.types.ts`.

| file | contents |
|---|---|
| `0001_types.sql` | pgcrypto (either schema), enums `user_role`, `trip_direction`, `trip_status`, `booking_status`, `pickup_request_status`, `push_status`, `notification_kind` |
| `0002_tables.sql` | all tables + indexes, `updated_at` triggers, `handle_new_user()` (auth.users → profiles), `profiles_protect_role()` |
| `0003_fn_booking.sql` | `book_seat`, `cancel_booking`, `promote_waitlist`, `set_booking_status` (+ internal `booking_promote_next`, `booking_renumber_waitlist`) |
| `0004_fn_notify.sql` | `render_text`, `render_template`, `enqueue_notification`, `claim_pending_notifications`, `finish_notification`, `mark_notifications_read`, `format_fare`, `format_local_time` |
| `0005_fn_trips_tick.sql` | `local_now`, `materialize_trips`, `create_adhoc_trip`, `set_trip_status`, `run_tick` |
| `0006_rls.sql` | `my_role()`, grants, RLS on every table |
| `0007_realtime.sql` | `trip_locations` → `trips.last_*` (throttled to one update per 15 s) + `realtime.send` broadcast on `trip:<id>`, publication membership, `replica identity full`, `realtime.messages` policy |
| `0008_seed.sql` | settings row, message templates, default pickup points, default timetable (all `on conflict do nothing`) |
| `0009_cron.sql` | `cron_tick()` + pg_cron jobs — no-op unless `pg_cron` **and** `pg_net` are installed |
| `0010_login_lockout.sql` | `record_login_failure(username, max_failures, lockout_minutes)` — one atomic upsert per sign-in attempt (the login/change-PIN routes reserve the attempt before asking Supabase Auth) |
| `0011_reseat_guard.sql` | `set_booking_status` re-created: re-seating a no-show/cancelled rider on a full trip raises `CONFLICT` instead of overbooking |

All migrations are idempotent: re-applying any of them on an already-migrated database
is safe (`if not exists`, `create or replace`, `drop policy if exists`, `on conflict do nothing`).

## Deploying to the hosted project

1. **Enable extensions** (Dashboard → Database → Extensions, or SQL):
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   -- supabase_vault and pgcrypto are on by default
   ```
   Enable `pg_cron` and `pg_net` **before** applying `0009_cron.sql`; otherwise re-run that
   file afterwards (it is guarded and simply skips when they are missing).
2. **Apply the migrations** in order, e.g. `supabase db push` with the CLI linked to the
   project, or paste each file into the SQL editor.
3. **Auth settings**: disable public sign-ups and email confirmations. Users are created
   only by the app via `auth.admin.createUser({ email: '<username>@users.kharis-shuttle.local',
   email_confirm: true, user_metadata: { username, full_name, phone, room }, app_metadata: { role } })`.
   `handle_new_user()` copies the metadata into `profiles`; the role is read from
   **app_metadata only** (never user_metadata) and defaults to `student`.
4. **Seed the first admin** with `pnpm seed:admin` (service role).
5. **Wire the minute ticker to the web app** — after the app is deployed, run once:
   ```sql
   select vault.create_secret('https://<your-app-domain>/api/cron/tick', 'tick_url');
   select vault.create_secret('<the CRON_SECRET from the app env>', 'cron_secret');
   ```
   `cron_tick()` runs `run_tick()` in SQL every minute regardless, then POSTs to `tick_url`
   with `Authorization: Bearer <cron_secret>` and body `{"source":"pg_cron","at":…}`
   (8 s timeout, failures only log a warning) so the Node side drains the push outbox.
   `run_tick()` is idempotent, but the Node route skips its own `rpc('run_tick')` when the
   body says `source = 'pg_cron'` (the SQL side already ran it) and only drains the outbox;
   a backup caller (cron-job.org, manual curl) sends no `source` and gets both halves.
   To rotate: `select vault.update_secret(id, '<new>') from vault.secrets where name = 'cron_secret'`.
6. Check it is alive: `select * from cron.job;` and `select * from tick_runs order by id desc limit 5;`.
   `cron.job_run_details` is pruned nightly at 03:00 (rows older than 7 days).

Run the Supabase security advisor afterwards; every function is `security definer` with a
fixed `search_path`, and every table has RLS enabled.

## Local development & tests

```bash
pnpm db:up        # start local PG16 on :54329, apply shims + migrations
pnpm db:reset     # drop, recreate, re-apply everything
pnpm test:sql     # vitest project "sql" — each file resets the DB and applies supabase/seed.local.sql
pnpm db:down
```

`supabase/seed.local.sql` is **test-only** (admin `ama_admin`, driver `kofi_driver`, students
`abena`, `yaw`, `efua`, inserted straight into `auth.users`). Never run it on the hosted project.

Tests impersonate users the way PostgREST does:
`select test_set_auth('<uuid>', 'authenticated'); set local role authenticated;` inside a
transaction (see `tests/sql/helpers.ts`).

To regenerate the TypeScript types for a diff against `src/lib/db.types.ts`:
```bash
npx supabase gen types typescript --db-url "postgres://postgres@127.0.0.1:54329/kharis_test?sslmode=disable" --schema public
```

## Behaviour notes for route handlers

* **Errors** from SQL functions are `raise exception 'CODE: message'` with
  `TRIP_NOT_OPEN`, `BOOKING_CLOSED`, `ALREADY_BOOKED`, `PICKUP_INVALID`, `NOT_FOUND`,
  `FORBIDDEN` and `CONFLICT` (invalid status transition). `fromPostgresError()` in
  `src/lib/api.ts` maps the first six; `CONFLICT` should be added to its `known` list
  so invalid transitions become 409 instead of 500.
* **Counters**: `trips.confirmed_count` = bookings `confirmed` + `boarded`;
  `trips.waitlist_count` = `waitlisted`. Every function keeps them exact.
* **Waitlist fairness**: `book_seat()` confirms a new rider only when a seat is free **and**
  `waitlist_count = 0`; while anyone is waitlisted every newcomer joins the end of the
  waitlist, even if a seat was just released. Seats freed by `no_show` or a capacity raise
  are filled in order by `promote_waitlist()`.
* `cancel_booking()` returns `{ cancelled, promoted }` — the handler should enqueue
  `booking_promoted` for `promoted` (SQL never sends booking_* notifications itself).
  Only the owner or an **active** driver/admin may cancel (deactivated staff → `FORBIDDEN`).
* `set_booking_status(…, 'no_show')` frees the seat but does **not** auto-promote; the
  handler must call `promote_waitlist(trip_id)` right after (it returns the promoted rows
  to notify). Likewise after an admin raises `trips.seat_capacity`: update, then
  `promote_waitlist(trip_id)`.
* `set_trip_status(…, 'cancelled')` leaves bookings untouched so the handler can notify
  `bookings where trip_id = … and status in ('confirmed','waitlisted')`.
* `create_adhoc_trip()` starts in `boarding` when departure is within 15 min, and
  schedules no reminder when the reminder lead has already passed (the announce handler
  pushes `return_announcement` itself).
* `run_tick(p_now)` returns the `tick_runs` row; the Node drain may update
  `pushes_sent` / `pushes_failed` on it by id.
* `claim_pending_notifications()` returns `subscriptions` as `[]` for users without an
  active subscription → mark those `skipped` via `finish_notification`. It also returns
  `push_attempts` (already including the current claim). Rows are retried by passing
  `'pending'` to `finish_notification`, which keeps `push_claimed_at`: a `pending` row is
  only claimable again when `push_claimed_at` is null or older than 45 s, so a drain run
  can never re-serve a row it just handed back (the retry happens on the next run). After
  5 attempts rows are left alone and the tick marks them `failed`.
* `render_template()` / `render_text()` substitute placeholders in a **single pass** over the
  original template: a value containing `{message}` is emitted literally. Runs of spaces/tabs
  collapse to one space; newlines are preserved. `enqueue_notification()` treats a null or
  unknown `p_urgency` as `'normal'`.
* **Reminder timing**: for scheduled trips (`schedule_time_id` set) `run_tick()` computes the
  reminder moment at tick time as `departure_at − settings.reminder_lead_minutes`, so editing
  the lead in settings applies to already-materialised trips; `trips.reminder_at` is only
  authoritative for ad-hoc trips (null = no reminder).
* Notification dedupe keys used by the tick: `daily:<date>:<user>`,
  `reminder:<trip>:<departure epoch s>:<user>`, `nudge:<trip>:<departure epoch s>:<user>`,
  `manifest:<trip>:<departure epoch s>:<user>`, `pr_expired:<request>:<user>`. The departure
  epoch (`extract(epoch from departure_at)::bigint`, i.e. `Math.round(Date.parse(departure_at) / 1000)`
  in TypeScript) is part of the per-trip prefixes so that an admin who **moves `departure_at`
  and nulls `reminder_sent_at` / `nudge_sent_at` / `manifest_sent_at`** gets those messages
  re-sent for the new time, while resetting a flag without changing the time can never
  double-send to the same recipient. A handler that sends one of these early (e.g.
  `POST /api/admin/trips` with `notify`) must use the same prefix so the tick stays silent.
* **Daily cleanup** runs once per local date: the tick writes `note = 'cleanup:<date>'` on the
  run that did it and skips when any `tick_runs.note` **starts with** `cleanup:<date>` (the
  admin's manual tick appends ` manual` to the note, which must still count).
* **Live position**: every `trip_locations` insert broadcasts the fix on `trip:<trip_id>`, but
  `trips.last_lat/lng/heading/speed_mps/location_at` is refreshed at most once per 15 s per
  trip (newest `recorded_at` wins; older late-arriving fixes never move the bus backwards),
  because `trips` is in the realtime publication and every update fans out to every open
  page. `trips`, `bookings`, `pickup_requests` and `notifications` have `replica identity
  full`, so `postgres_changes` UPDATE events carry the old row and clients can ignore
  changes that only touch the `last_*` columns.
* **One open pickup request per rider**: the partial unique index `pickup_requests_one_pending`
  (`rider_id` where `status = 'pending'`) makes a second pending insert fail with `23505`;
  the API maps it to a 409 pointing at the existing request. Once that request is
  accepted / declined / cancelled / expired the rider can open a new one.
* **RLS**: clients can only read (see the matrix at the top of `0006_rls.sql`); the only
  client write is a user's own `profiles` row (`full_name`, `phone`, `room`,
  `reminders_enabled`, `onboarded_at`). `anon` can read nothing — the public landing page
  must read today's times with the service-role client.
* **`settings` is column-restricted for browser clients**: `authenticated` has select on
  every column **except** `signup_code`, `default_driver_id` and `updated_by`. A browser
  client must therefore never `.select('*')` on `settings` — it fails with `permission
  denied` — and must list the columns it needs (`hostel_name, fare_pesewas, …`). Server code
  reads `settings` with the service role and sees everything.
