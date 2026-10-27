-- 0002_tables.sql — every table, constraint, index and housekeeping trigger.
-- Column names / nullability / defaults mirror src/lib/db.types.ts (the contract).

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user (username + PIN auth lives on top of Supabase Auth)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  username          text not null,
  full_name         text not null,
  phone             text,
  room              text,
  role              public.user_role not null default 'student',
  is_active         boolean not null default true,
  reminders_enabled boolean not null default true,
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint profiles_username_key unique (username),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_full_name_len check (char_length(full_name) between 1 and 80)
);
comment on table public.profiles is 'App profile for every auth user. Created by trigger on auth.users.';

create index if not exists profiles_role_active_idx on public.profiles (role, is_active);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Copy username / full_name / phone / room from the auth metadata when the
-- auth user is created (auth.admin.createUser({ user_metadata: {...} })).
-- The role may only come from app_metadata (admin API) — never from user_metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_username text;
  v_role     public.user_role := 'student';
begin
  v_username := lower(coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  ));
  if v_username = '' then
    -- Not one of ours (no username anywhere): leave it without a profile.
    return new;
  end if;

  if coalesce(new.raw_app_meta_data ->> 'role', '') in ('student', 'driver', 'admin') then
    v_role := (new.raw_app_meta_data ->> 'role')::public.user_role;
  end if;

  insert into public.profiles (id, username, full_name, phone, room, role)
  values (
    new.id,
    v_username,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), v_username),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'room'), ''),
    v_role
  )
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only the service role (route handlers after a role check) or a direct superuser
-- connection may change role / is_active. Anything with a JWT role of
-- `authenticated` / `anon` is blocked even if an RLS policy let the update through.
create or replace function public.profiles_protect_role()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_jwt_role text;
begin
  if new.role is distinct from old.role or new.is_active is distinct from old.is_active then
    v_jwt_role := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
    if v_jwt_role is null or v_jwt_role = 'service_role' then
      return new;
    end if;
    raise exception 'FORBIDDEN: Only the hostel office can change roles or deactivate accounts'
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.profiles_protect_role();

-- ---------------------------------------------------------------------------
-- settings — singleton (id = 1), admin-editable
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id                          integer primary key default 1,
  hostel_name                 text not null default 'Kharis Courts Hostel',
  campus_name                 text not null default 'KNUST',
  timezone                    text not null default 'Africa/Accra',
  fare_pesewas                integer not null default 1000,
  currency                    text not null default 'GHS',
  payment_note                text not null default 'Cash only — pay the driver when you board',
  enquiry_phone               text,
  default_seat_capacity       integer not null default 14,
  reminder_lead_minutes       integer not null default 60,
  nudge_minutes               integer not null default 10,
  manifest_lead_minutes       integer not null default 15,
  booking_cutoff_minutes      integer not null default 5,
  booking_open_days_ahead     integer not null default 1,
  daily_announcement_enabled  boolean not null default true,
  daily_announcement_time     time not null default '06:00',
  location_stale_seconds      integer not null default 90,
  signup_code                 text,
  default_driver_id           uuid references public.profiles (id) on delete set null,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references public.profiles (id) on delete set null,
  constraint settings_singleton check (id = 1),
  constraint settings_fare_nonneg check (fare_pesewas >= 0),
  constraint settings_capacity_pos check (default_seat_capacity > 0),
  constraint settings_minutes_nonneg check (
    reminder_lead_minutes >= 0 and nudge_minutes >= 0 and manifest_lead_minutes >= 0
    and booking_cutoff_minutes >= 0 and booking_open_days_ahead >= 0 and location_stale_seconds > 0
  )
);
comment on table public.settings is 'Single row (id = 1) of hostel-wide configuration.';

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- message_templates — one per notification kind, admin-editable, {placeholders}
-- ---------------------------------------------------------------------------
create table if not exists public.message_templates (
  key        public.notification_kind primary key,
  title      text not null,
  body       text not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists message_templates_set_updated_at on public.message_templates;
create trigger message_templates_set_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- pickup_locations
-- ---------------------------------------------------------------------------
create table if not exists public.pickup_locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  direction   public.trip_direction,          -- null = both directions
  lat         double precision not null,
  lng         double precision not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint pickup_locations_name_len check (char_length(name) between 1 and 80),
  constraint pickup_locations_lat_range check (lat between -90 and 90),
  constraint pickup_locations_lng_range check (lng between -180 and 180)
);

create index if not exists pickup_locations_active_idx on public.pickup_locations (is_active, sort_order);

-- ---------------------------------------------------------------------------
-- schedule_times — the recurring timetable
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_times (
  id               uuid primary key default gen_random_uuid(),
  direction        public.trip_direction not null,
  depart_time      time not null,
  days_of_week     smallint[] not null default '{1,2,3,4,5}',   -- ISO: 1 = Mon … 7 = Sun
  label            text,
  seat_capacity    integer,                                      -- null → settings.default_seat_capacity
  bookings_enabled boolean not null default true,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint schedule_times_direction_time_key unique (direction, depart_time),
  constraint schedule_times_days_valid check (
    cardinality(days_of_week) >= 1 and days_of_week <@ '{1,2,3,4,5,6,7}'::smallint[]
  ),
  constraint schedule_times_capacity_pos check (seat_capacity is null or seat_capacity > 0)
);

-- ---------------------------------------------------------------------------
-- service_days_off — no shuttle on these dates (holidays, breaks)
-- ---------------------------------------------------------------------------
create table if not exists public.service_days_off (
  service_date date primary key,
  reason       text
);

-- ---------------------------------------------------------------------------
-- trips — one row per departure (materialized from schedule_times or ad hoc)
-- ---------------------------------------------------------------------------
create table if not exists public.trips (
  id                uuid primary key default gen_random_uuid(),
  service_date      date not null,
  direction         public.trip_direction not null,
  departure_at      timestamptz not null,
  schedule_time_id  uuid references public.schedule_times (id) on delete set null,
  status            public.trip_status not null default 'scheduled',
  seat_capacity     integer not null,
  confirmed_count   integer not null default 0,
  waitlist_count    integer not null default 0,
  bookings_enabled  boolean not null default true,
  driver_id         uuid references public.profiles (id) on delete set null,
  origin_label      text not null,
  destination_label text not null,
  reminder_at       timestamptz,
  reminder_sent_at  timestamptz,
  nudge_sent_at     timestamptz,
  manifest_sent_at  timestamptz,
  boarding_at       timestamptz,
  departed_at       timestamptz,
  arrived_at        timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  last_lat          double precision,
  last_lng          double precision,
  last_heading      double precision,
  last_speed_mps    double precision,
  last_location_at  timestamptz,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint trips_capacity_pos check (seat_capacity > 0),
  constraint trips_counts_nonneg check (confirmed_count >= 0 and waitlist_count >= 0)
);

-- One trip per schedule slot per day (ad-hoc trips have schedule_time_id null).
create unique index if not exists trips_schedule_date_key
  on public.trips (schedule_time_id, service_date)
  where schedule_time_id is not null;
create index if not exists trips_service_date_idx on public.trips (service_date, departure_at);
create index if not exists trips_status_departure_idx on public.trips (status, departure_at);
create index if not exists trips_driver_idx on public.trips (driver_id) where driver_id is not null;
create index if not exists trips_reminder_due_idx on public.trips (reminder_at) where reminder_sent_at is null;

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- bookings — a student's seat (or waitlist place) on a trip
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  trip_id            uuid not null references public.trips (id) on delete cascade,
  user_id            uuid not null references public.profiles (id) on delete cascade,
  pickup_location_id uuid references public.pickup_locations (id) on delete set null,
  pickup_note        text,
  status             public.booking_status not null,
  waitlist_position  integer,
  agreed_cash_at     timestamptz not null default now(),
  source             text not null default 'self',          -- self | driver | admin | request
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  cancelled_at       timestamptz,
  promoted_at        timestamptz,
  boarded_at         timestamptz,
  constraint bookings_trip_user_key unique (trip_id, user_id),
  constraint bookings_waitlist_pos_pos check (waitlist_position is null or waitlist_position > 0)
);

create index if not exists bookings_user_idx on public.bookings (user_id, created_at desc);
create index if not exists bookings_trip_status_idx on public.bookings (trip_id, status);

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- pickup_requests — "can you pick me up at …" (driver accepts / declines)
-- ---------------------------------------------------------------------------
create table if not exists public.pickup_requests (
  id                 uuid primary key default gen_random_uuid(),
  rider_id           uuid not null references public.profiles (id) on delete cascade,
  trip_id            uuid references public.trips (id) on delete set null,
  direction          public.trip_direction not null,
  pickup_location_id uuid references public.pickup_locations (id) on delete set null,
  custom_place       text,
  lat                double precision,
  lng                double precision,
  note               text,
  status             public.pickup_request_status not null default 'pending',
  driver_id          uuid references public.profiles (id) on delete set null,
  responded_at       timestamptz,
  response_note      text,
  expires_at         timestamptz not null default (now() + interval '30 minutes'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pickup_requests_place_or_location check (
    pickup_location_id is not null or custom_place is not null or (lat is not null and lng is not null)
  )
);

create index if not exists pickup_requests_rider_idx on public.pickup_requests (rider_id, created_at desc);
create index if not exists pickup_requests_pending_idx on public.pickup_requests (expires_at) where status = 'pending';
-- One open request per rider (the API maps the 23505 to a 409 pointing at the existing one).
create unique index if not exists pickup_requests_one_pending on public.pickup_requests (rider_id) where status = 'pending';
create index if not exists pickup_requests_trip_idx on public.pickup_requests (trip_id) where trip_id is not null;

drop trigger if exists pickup_requests_set_updated_at on public.pickup_requests;
create trigger pickup_requests_set_updated_at
  before update on public.pickup_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- trip_locations — GPS fixes while the driver is tracking (pruned after 7 days)
-- ---------------------------------------------------------------------------
create table if not exists public.trip_locations (
  id          bigint generated by default as identity primary key,
  trip_id     uuid not null references public.trips (id) on delete cascade,
  driver_id   uuid references public.profiles (id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  accuracy_m  double precision,
  heading     double precision,
  speed_mps   double precision,
  recorded_at timestamptz not null,
  inserted_at timestamptz not null default now()
);

create index if not exists trip_locations_trip_recorded_idx on public.trip_locations (trip_id, recorded_at);
create index if not exists trip_locations_inserted_idx on public.trip_locations (inserted_at);

-- ---------------------------------------------------------------------------
-- push_subscriptions — Web Push endpoints (service role only)
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  endpoint        text not null,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  platform        text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  last_success_at timestamptz,
  fail_count      integer not null default 0,
  disabled_at     timestamptz,
  constraint push_subscriptions_endpoint_key unique (endpoint)
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id) where disabled_at is null;

-- ---------------------------------------------------------------------------
-- notifications — inbox + push outbox (one row per recipient)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  kind            public.notification_kind not null,
  title           text not null,
  body            text not null,
  url             text,
  data            jsonb not null default '{}'::jsonb,
  dedupe_key      text not null,
  ttl_seconds     integer not null default 3600,
  urgency         text not null default 'normal',          -- very-low | low | normal | high
  collapse_tag    text,
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  push_status     public.push_status not null default 'pending',
  push_attempts   integer not null default 0,
  push_claimed_at timestamptz,
  push_sent_at    timestamptz,
  push_error      text,
  constraint notifications_dedupe_key unique (dedupe_key),
  constraint notifications_ttl_pos check (ttl_seconds > 0),
  constraint notifications_urgency_valid check (urgency in ('very-low', 'low', 'normal', 'high'))
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_outbox_idx on public.notifications (created_at)
  where push_status in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- login_attempts — PIN brute-force lockout (service role only)
-- ---------------------------------------------------------------------------
create table if not exists public.login_attempts (
  username     text primary key,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

drop trigger if exists login_attempts_set_updated_at on public.login_attempts;
create trigger login_attempts_set_updated_at
  before update on public.login_attempts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tick_runs — audit trail of run_tick()
-- ---------------------------------------------------------------------------
create table if not exists public.tick_runs (
  id                 bigint generated by default as identity primary key,
  ran_at             timestamptz not null default now(),
  now_ts             timestamptz not null,
  trips_created      integer not null default 0,
  daily_enqueued     integer not null default 0,
  reminders_enqueued integer not null default 0,
  nudges_enqueued    integer not null default 0,
  manifests_enqueued integer not null default 0,
  expired_trips      integer not null default 0,
  expired_requests   integer not null default 0,
  pushes_sent        integer not null default 0,
  pushes_failed      integer not null default 0,
  duration_ms        integer,
  note               text
);

create index if not exists tick_runs_ran_at_idx on public.tick_runs (ran_at desc);
create index if not exists tick_runs_note_idx on public.tick_runs (note) where note is not null;
