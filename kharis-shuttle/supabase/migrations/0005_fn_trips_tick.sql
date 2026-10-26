-- 0005_fn_trips_tick.sql — trip materialisation, ad-hoc trips, status transitions and
-- the idempotent minute tick (run_tick). Everything that depends on "what time is it"
-- takes p_now so the tests can replay a day deterministically.

-- ---------------------------------------------------------------------------
-- local_now — wall-clock time in settings.timezone (timestamp without time zone)
-- ---------------------------------------------------------------------------
create or replace function public.local_now(p_now timestamptz default now())
returns timestamp
language sql
stable
set search_path = public, extensions
as $$
  select coalesce(p_now, now()) at time zone coalesce((select timezone from public.settings where id = 1), 'Africa/Accra');
$$;

grant execute on function public.local_now(timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- materialize_trips — create the trips for every date in [p_from, p_to] from the
-- active schedule, skipping service_days_off. Idempotent (unique (schedule_time_id,
-- service_date) + on conflict do nothing). Returns the number of trips created.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_trips(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s        public.settings;
  v_count  integer := 0;
begin
  select * into s from public.settings where id = 1;
  if not found then
    insert into public.settings (id) values (1) on conflict (id) do nothing;
    select * into s from public.settings where id = 1;
  end if;

  insert into public.trips (
    service_date, direction, departure_at, schedule_time_id, status, seat_capacity, bookings_enabled,
    driver_id, origin_label, destination_label, reminder_at
  )
  select d::date,
         st.direction,
         (d::date + st.depart_time) at time zone s.timezone,
         st.id,
         'scheduled',
         coalesce(st.seat_capacity, s.default_seat_capacity),
         st.bookings_enabled,
         s.default_driver_id,
         case st.direction when 'to_campus' then s.hostel_name else s.campus_name end,
         case st.direction when 'to_campus' then s.campus_name else s.hostel_name end,
         ((d::date + st.depart_time) at time zone s.timezone) - make_interval(mins => s.reminder_lead_minutes)
    from public.schedule_times st
   cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d
   where st.is_active
     and extract(isodow from d)::smallint = any (st.days_of_week)
     and not exists (select 1 from public.service_days_off o where o.service_date = d::date)
  on conflict (schedule_time_id, service_date) where schedule_time_id is not null do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.materialize_trips(date, date) from public, anon, authenticated;
grant execute on function public.materialize_trips(date, date) to service_role;

-- ---------------------------------------------------------------------------
-- create_adhoc_trip — e.g. the driver's "shuttle is at KSB heading to the hostel".
-- Starts in 'boarding' when it leaves within 15 minutes, otherwise 'scheduled'.
-- No reminder is scheduled when the reminder lead has already passed (the caller
-- announces it directly), so riders are not pinged twice.
-- ---------------------------------------------------------------------------
create or replace function public.create_adhoc_trip(
  p_direction     public.trip_direction,
  p_origin        text,
  p_destination   text,
  p_departure_at  timestamptz,
  p_seat_capacity integer default null,
  p_driver_id     uuid default null,
  p_created_by    uuid default null
)
returns public.trips
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s            public.settings;
  v_trip       public.trips;
  v_status     public.trip_status;
  v_reminder   timestamptz;
begin
  select * into s from public.settings where id = 1;
  if not found then
    insert into public.settings (id) values (1) on conflict (id) do nothing;
    select * into s from public.settings where id = 1;
  end if;

  v_status := case when p_departure_at <= now() + interval '15 minutes' then 'boarding' else 'scheduled' end;
  v_reminder := p_departure_at - make_interval(mins => s.reminder_lead_minutes);
  if v_reminder <= now() then
    v_reminder := null;
  end if;

  insert into public.trips (
    service_date, direction, departure_at, schedule_time_id, status, seat_capacity, bookings_enabled,
    driver_id, origin_label, destination_label, reminder_at, boarding_at, created_by
  )
  values (
    (p_departure_at at time zone s.timezone)::date,
    p_direction,
    p_departure_at,
    null,
    v_status,
    coalesce(p_seat_capacity, s.default_seat_capacity),
    true,
    coalesce(p_driver_id, s.default_driver_id),
    p_origin,
    p_destination,
    v_reminder,
    case when v_status = 'boarding' then now() else null end,
    p_created_by
  )
  returning * into v_trip;

  return v_trip;
end
$$;

revoke all on function public.create_adhoc_trip(public.trip_direction, text, text, timestamptz, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_adhoc_trip(public.trip_direction, text, text, timestamptz, integer, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- set_trip_status — validated transitions with timestamps.
--   scheduled → boarding | departed | cancelled | expired
--   boarding  → departed | arrived | cancelled | expired
--   departed  → arrived  | cancelled
-- A driver actor claims an unassigned trip when starting boarding / departing.
-- Bookings are left untouched on cancel so the caller can notify the riders.
-- ---------------------------------------------------------------------------
create or replace function public.set_trip_status(
  p_trip_id uuid,
  p_status  public.trip_status,
  p_actor   uuid default null,
  p_reason  text default null
)
returns public.trips
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip  public.trips;
  v_ok    boolean;
  v_actor_role public.user_role;
begin
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: Trip not found' using errcode = 'P0001';
  end if;

  if v_trip.status = p_status then
    return v_trip;
  end if;

  v_ok := case v_trip.status
    when 'scheduled' then p_status in ('boarding', 'departed', 'cancelled', 'expired')
    when 'boarding'  then p_status in ('departed', 'arrived', 'cancelled', 'expired')
    when 'departed'  then p_status in ('arrived', 'cancelled')
    else false
  end;
  if not v_ok then
    raise exception 'CONFLICT: Cannot change a % trip to %', v_trip.status, p_status using errcode = 'P0001';
  end if;

  if p_actor is not null and v_trip.driver_id is null and p_status in ('boarding', 'departed') then
    select role into v_actor_role from public.profiles where id = p_actor and is_active;
    if v_actor_role = 'driver' then
      v_trip.driver_id := p_actor;
    end if;
  end if;

  update public.trips
     set status        = p_status,
         driver_id     = v_trip.driver_id,
         boarding_at   = case when p_status = 'boarding' then now() else boarding_at end,
         departed_at   = case when p_status = 'departed' then now() else departed_at end,
         arrived_at    = case when p_status = 'arrived' then now() else arrived_at end,
         cancelled_at  = case when p_status = 'cancelled' then now() else cancelled_at end,
         cancel_reason = case when p_status = 'cancelled' then nullif(trim(coalesce(p_reason, '')), '') else cancel_reason end,
         bookings_enabled = case when p_status in ('departed', 'arrived', 'cancelled', 'expired') then false else bookings_enabled end
   where id = p_trip_id
   returning * into v_trip;

  return v_trip;
end
$$;

revoke all on function public.set_trip_status(uuid, public.trip_status, uuid, text) from public, anon, authenticated;
grant execute on function public.set_trip_status(uuid, public.trip_status, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- run_tick — the minute tick. Idempotent: every side effect is guarded by a
-- `where … is null` update or a dedupe key, so running it 50 times at the same
-- p_now, or minutes late, never double-sends. Called by pg_cron (cron_tick) and by
-- POST /api/cron/tick. Returns the tick_runs audit row.
-- ---------------------------------------------------------------------------
create or replace function public.run_tick(p_now timestamptz default now())
returns public.tick_runs
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s              public.settings;
  v_now          timestamptz := coalesce(p_now, now());
  v_started      timestamptz := clock_timestamp();
  v_local        timestamp;
  v_date         date;
  v_fare         text;
  v_announce_at  timestamptz;
  v_times        text;
  v_trip         public.trips;
  v_rider        record;
  v_req          record;
  v_recipients   uuid[];
  v_summary      text;
  v_n            integer;
  v_cutoff       interval;
  v_run          public.tick_runs;
  v_trips_created      integer := 0;
  v_daily_enqueued     integer := 0;
  v_reminders_enqueued integer := 0;
  v_nudges_enqueued    integer := 0;
  v_manifests_enqueued integer := 0;
  v_expired_trips      integer := 0;
  v_expired_requests   integer := 0;
  v_note               text := null;
begin
  -- Settings (self-heal if the seed has not run yet).
  select * into s from public.settings where id = 1;
  if not found then
    insert into public.settings (id) values (1) on conflict (id) do nothing;
    select * into s from public.settings where id = 1;
  end if;

  v_local  := v_now at time zone s.timezone;
  v_date   := v_local::date;
  v_fare   := public.format_fare(s.fare_pesewas, s.currency);
  v_cutoff := make_interval(mins => s.booking_cutoff_minutes);

  -- 1. Materialise today .. today + booking_open_days_ahead.
  v_trips_created := public.materialize_trips(v_date, v_date + s.booking_open_days_ahead);

  -- 2. Daily announcement: once per local date, within [announce_at, announce_at + 2h).
  if s.daily_announcement_enabled then
    v_announce_at := (v_date + s.daily_announcement_time) at time zone s.timezone;
    if v_now >= v_announce_at and v_now < v_announce_at + interval '2 hours' then
      select string_agg(to_char(t.departure_at at time zone s.timezone, 'FMHH12:MI AM'), ', ' order by t.departure_at)
        into v_times
        from public.trips t
       where t.service_date = v_date
         and t.direction = 'to_campus'
         and t.status in ('scheduled', 'boarding');
      if v_times is not null then
        v_daily_enqueued := public.enqueue_notification(
          array(select p.id from public.profiles p where p.role = 'student' and p.is_active and p.reminders_enabled),
          'daily_announcement',
          jsonb_build_object(
            'hostel', s.hostel_name,
            'campus', s.campus_name,
            'times', v_times,
            'fare', v_fare,
            'date', to_char(v_date, 'FMDy FMDD Mon')
          ),
          '/app',
          'daily:' || v_date::text,
          4 * 3600,
          'normal',
          'daily'
        );
      end if;
    end if;
  end if;

  -- 3. Trip reminders: students WITHOUT an active booking, while booking is still open.
  for v_trip in
    select * from public.trips t
     where t.status in ('scheduled', 'boarding')
       and t.bookings_enabled
       and t.reminder_at is not null
       and t.reminder_sent_at is null
       and t.reminder_at <= v_now
       and v_now < t.departure_at - v_cutoff
     order by t.departure_at
  loop
    update public.trips set reminder_sent_at = v_now
     where id = v_trip.id and reminder_sent_at is null;
    if found then
      v_n := public.enqueue_notification(
        array(
          select p.id from public.profiles p
           where p.role = 'student' and p.is_active and p.reminders_enabled
             and not exists (
               select 1 from public.bookings b
                where b.trip_id = v_trip.id and b.user_id = p.id
                  and b.status in ('confirmed', 'waitlisted', 'boarded')
             )
        ),
        'trip_reminder',
        jsonb_build_object(
          'time', to_char(v_trip.departure_at at time zone s.timezone, 'FMHH12:MI AM'),
          'seats_left', greatest(v_trip.seat_capacity - v_trip.confirmed_count, 0),
          'seats', v_trip.seat_capacity,
          'fare', v_fare,
          'origin', v_trip.origin_label,
          'destination', v_trip.destination_label,
          'hostel', s.hostel_name,
          'trip_id', v_trip.id
        ),
        '/app/trips/' || v_trip.id::text,
        'reminder:' || v_trip.id::text,
        greatest(least(extract(epoch from (v_trip.departure_at - v_now))::integer, 3600), 60),
        'normal',
        'trip:' || v_trip.id::text
      );
      v_reminders_enqueued := v_reminders_enqueued + v_n;
    end if;
  end loop;
  -- Reminder window already passed (late first tick, cancelled, etc.): close it silently.
  update public.trips set reminder_sent_at = v_now
   where reminder_sent_at is null
     and reminder_at is not null
     and v_now >= departure_at - v_cutoff;

  -- 4. Nudges: confirmed riders, [departure - nudge_minutes, departure).
  for v_trip in
    select * from public.trips t
     where t.status in ('scheduled', 'boarding')
       and t.nudge_sent_at is null
       and t.departure_at - make_interval(mins => s.nudge_minutes) <= v_now
       and v_now < t.departure_at
     order by t.departure_at
  loop
    update public.trips set nudge_sent_at = v_now
     where id = v_trip.id and nudge_sent_at is null;
    if found then
      for v_rider in
        select b.user_id, coalesce(pl.name, 'your pickup point') as pickup
          from public.bookings b
          left join public.pickup_locations pl on pl.id = b.pickup_location_id
         where b.trip_id = v_trip.id and b.status = 'confirmed'
      loop
        v_n := public.enqueue_notification(
          array[v_rider.user_id],
          'trip_nudge',
          jsonb_build_object(
            'count', s.nudge_minutes,
            'pickup', v_rider.pickup,
            'fare', v_fare,
            'time', to_char(v_trip.departure_at at time zone s.timezone, 'FMHH12:MI AM'),
            'destination', v_trip.destination_label,
            'origin', v_trip.origin_label,
            'trip_id', v_trip.id
          ),
          '/app/trips/' || v_trip.id::text,
          'nudge:' || v_trip.id::text,
          greatest(extract(epoch from (v_trip.departure_at - v_now))::integer, 60),
          'high',
          'trip:' || v_trip.id::text
        );
        v_nudges_enqueued := v_nudges_enqueued + v_n;
      end loop;
    end if;
  end loop;
  update public.trips set nudge_sent_at = v_now
   where nudge_sent_at is null and v_now >= departure_at;

  -- 5. Driver manifest: [departure - manifest_lead, departure + 30 min).
  for v_trip in
    select * from public.trips t
     where t.status in ('scheduled', 'boarding', 'departed')
       and t.manifest_sent_at is null
       and t.departure_at - make_interval(mins => s.manifest_lead_minutes) <= v_now
       and v_now < t.departure_at + interval '30 minutes'
     order by t.departure_at
  loop
    update public.trips set manifest_sent_at = v_now
     where id = v_trip.id and manifest_sent_at is null;
    if found then
      if v_trip.driver_id is not null then
        v_recipients := array[v_trip.driver_id];
      else
        v_recipients := array(select p.id from public.profiles p where p.role = 'driver' and p.is_active);
      end if;

      select string_agg(g.name || ' ×' || g.n, ', ' order by g.n desc, g.name)
        into v_summary
        from (
          select coalesce(pl.name, 'No pickup point') as name, count(*) as n
            from public.bookings b
            left join public.pickup_locations pl on pl.id = b.pickup_location_id
           where b.trip_id = v_trip.id and b.status in ('confirmed', 'boarded')
           group by coalesce(pl.name, 'No pickup point')
        ) g;

      v_n := public.enqueue_notification(
        v_recipients,
        'driver_manifest',
        jsonb_build_object(
          'time', to_char(v_trip.departure_at at time zone s.timezone, 'FMHH12:MI AM'),
          'destination', v_trip.destination_label,
          'origin', v_trip.origin_label,
          'count', v_trip.confirmed_count,
          'summary', coalesce(v_summary, 'No bookings yet'),
          'trip_id', v_trip.id
        ),
        '/driver/trips/' || v_trip.id::text,
        'manifest:' || v_trip.id::text,
        1800,
        'high',
        'manifest:' || v_trip.id::text
      );
      v_manifests_enqueued := v_manifests_enqueued + v_n;
    end if;
  end loop;
  update public.trips set manifest_sent_at = v_now
   where manifest_sent_at is null and v_now >= departure_at + interval '30 minutes';

  -- 6. Expiry.
  update public.trips
     set status = 'expired', bookings_enabled = false
   where status in ('scheduled', 'boarding')
     and departure_at + interval '90 minutes' < v_now;
  get diagnostics v_n = row_count;
  v_expired_trips := v_expired_trips + v_n;

  update public.trips
     set status = 'arrived', arrived_at = coalesce(arrived_at, v_now)
   where status = 'departed'
     and departed_at is not null
     and departed_at + interval '3 hours' < v_now;
  get diagnostics v_n = row_count;
  v_expired_trips := v_expired_trips + v_n;

  for v_req in
    update public.pickup_requests r
       set status = 'expired'
     where r.status = 'pending' and r.expires_at < v_now
    returning r.id, r.rider_id, r.pickup_location_id, r.custom_place
  loop
    v_expired_requests := v_expired_requests + 1;
    perform public.enqueue_notification(
      array[v_req.rider_id],
      'pickup_request_expired',
      jsonb_build_object(
        'pickup', coalesce((select pl.name from public.pickup_locations pl where pl.id = v_req.pickup_location_id),
                           v_req.custom_place, 'your pickup point'),
        'request_id', v_req.id
      ),
      '/app/requests/' || v_req.id::text,
      'pr_expired:' || v_req.id::text,
      3600,
      'normal',
      'request:' || v_req.id::text
    );
  end loop;

  -- 7. Outbox hygiene (wall-clock based: the drain runs in real time).
  update public.notifications
     set push_status = case when push_attempts >= 5 then 'failed'::public.push_status else 'pending'::public.push_status end,
         push_error  = case when push_attempts >= 5 then coalesce(push_error, 'gave up after 5 attempts') else push_error end,
         push_claimed_at = null
   where push_status = 'sending'
     and push_claimed_at < now() - interval '2 minutes';

  update public.notifications
     set push_status = 'skipped', push_error = 'expired before it could be sent'
   where push_status = 'pending'
     and created_at + make_interval(secs => ttl_seconds) < now();

  -- 8. Daily housekeeping, once per local date.
  if not exists (select 1 from public.tick_runs where note = 'cleanup:' || v_date::text) then
    delete from public.trip_locations where inserted_at < v_now - interval '7 days';
    delete from public.notifications where created_at < v_now - interval '60 days';
    delete from public.tick_runs where ran_at < v_now - interval '14 days';
    v_note := 'cleanup:' || v_date::text;
  end if;

  insert into public.tick_runs (
    now_ts, trips_created, daily_enqueued, reminders_enqueued, nudges_enqueued, manifests_enqueued,
    expired_trips, expired_requests, duration_ms, note
  )
  values (
    v_now, v_trips_created, v_daily_enqueued, v_reminders_enqueued, v_nudges_enqueued, v_manifests_enqueued,
    v_expired_trips, v_expired_requests,
    (extract(epoch from (clock_timestamp() - v_started)) * 1000)::integer, v_note
  )
  returning * into v_run;

  return v_run;
end
$$;

revoke all on function public.run_tick(timestamptz) from public, anon, authenticated;
grant execute on function public.run_tick(timestamptz) to service_role;
