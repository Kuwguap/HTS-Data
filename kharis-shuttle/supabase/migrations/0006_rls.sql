-- 0006_rls.sql — grants + row level security.
--
-- Principle: clients (anon key + user JWT) can only READ, and only what the matrix in
-- the plan allows. Every write goes through a route handler using the service role
-- after an explicit role check (the service role bypasses RLS). The one exception is
-- profiles: a user may update their own row (role / is_active are trigger-protected).
--
-- Matrix (authenticated):
--   profiles            own row select/update; staff select all
--   settings, pickup_locations, schedule_times, service_days_off   select
--   trips               select from local today-1 onward, or trips they booked; staff all
--   trip_locations      select last 2 days; staff all
--   bookings            own rows; staff all
--   pickup_requests     own rows; staff all
--   notifications       own rows (mark read via mark_notifications_read())
--   message_templates   admin select
--   tick_runs           admin select
--   push_subscriptions, login_attempts   nothing (service role only)
-- anon: nothing.

-- ---------------------------------------------------------------------------
-- my_role() — the caller's profile role, for policies. Security definer so it can
-- read profiles regardless of the profiles policies themselves.
-- ---------------------------------------------------------------------------
create or replace function public.my_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.is_active;
$$;

revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Table privileges (RLS restricts rows; privileges restrict verbs).
-- Supabase's default privileges grant ALL to anon/authenticated on new tables, so
-- we start from zero.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant select on
  public.profiles,
  public.settings,
  public.pickup_locations,
  public.schedule_times,
  public.service_days_off,
  public.trips,
  public.trip_locations,
  public.bookings,
  public.pickup_requests,
  public.notifications,
  public.message_templates,
  public.tick_runs
to authenticated;

grant update (full_name, phone, room, reminders_enabled, onboarded_at, updated_at)
  on public.profiles to authenticated;

-- Functions: start from zero for anon/authenticated, then re-grant the few client ones.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end
$$;

grant execute on function public.my_role() to authenticated;
grant execute on function public.local_now(timestamptz) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.format_fare(integer, text) to authenticated;
grant execute on function public.format_local_time(timestamptz) to authenticated;
-- Local test helper (exists only when scripts/pg-shims.sql ran).
do $$
begin
  if to_regprocedure('public.test_set_auth(uuid, text)') is not null then
    grant execute on function public.test_set_auth(uuid, text) to anon, authenticated, service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere (service_role has bypassrls).
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.settings           enable row level security;
alter table public.message_templates  enable row level security;
alter table public.pickup_locations   enable row level security;
alter table public.schedule_times     enable row level security;
alter table public.service_days_off   enable row level security;
alter table public.trips              enable row level security;
alter table public.bookings           enable row level security;
alter table public.pickup_requests    enable row level security;
alter table public.trip_locations     enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notifications      enable row level security;
alter table public.login_attempts     enable row level security;
alter table public.tick_runs          enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.my_role()) in ('driver', 'admin'));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- reference data
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings
  for select to authenticated using (true);

drop policy if exists pickup_locations_select on public.pickup_locations;
create policy pickup_locations_select on public.pickup_locations
  for select to authenticated using (true);

drop policy if exists schedule_times_select on public.schedule_times;
create policy schedule_times_select on public.schedule_times
  for select to authenticated using (true);

drop policy if exists service_days_off_select on public.service_days_off;
create policy service_days_off_select on public.service_days_off
  for select to authenticated using (true);

-- trips: recent + upcoming, plus anything the student booked (history); staff all
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips
  for select to authenticated
  using (
    (select public.my_role()) in ('driver', 'admin')
    or service_date >= (select public.local_now())::date - 1
    or exists (select 1 from public.bookings b where b.trip_id = trips.id and b.user_id = (select auth.uid()))
  );

-- trip_locations: same window (by time)
drop policy if exists trip_locations_select on public.trip_locations;
create policy trip_locations_select on public.trip_locations
  for select to authenticated
  using (
    (select public.my_role()) in ('driver', 'admin')
    or recorded_at >= now() - interval '2 days'
  );

-- bookings
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.my_role()) in ('driver', 'admin'));

-- pickup_requests
drop policy if exists pickup_requests_select on public.pickup_requests;
create policy pickup_requests_select on public.pickup_requests
  for select to authenticated
  using (rider_id = (select auth.uid()) or (select public.my_role()) in ('driver', 'admin'));

-- notifications
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- admin-only tables
drop policy if exists message_templates_select on public.message_templates;
create policy message_templates_select on public.message_templates
  for select to authenticated
  using ((select public.my_role()) = 'admin');

drop policy if exists tick_runs_select on public.tick_runs;
create policy tick_runs_select on public.tick_runs
  for select to authenticated
  using ((select public.my_role()) = 'admin');

-- push_subscriptions, login_attempts: RLS enabled, no policies → nothing for clients.
