-- 0003_fn_booking.sql — seat booking, cancellation, waitlist promotion.
--
-- All functions are security definer, run as the migration owner (postgres) and are
-- callable by the service role only (route handlers call them after a role check).
-- Errors meant for the UI are raised as 'CODE: message' (see src/lib/api.ts
-- fromPostgresError): TRIP_NOT_OPEN, BOOKING_CLOSED, ALREADY_BOOKED, PICKUP_INVALID,
-- NOT_FOUND, FORBIDDEN, CONFLICT.
--
-- Counter invariants (maintained by every path below):
--   trips.confirmed_count = count(bookings where status in ('confirmed','boarded'))
--   trips.waitlist_count  = count(bookings where status = 'waitlisted')
--   waitlist_position     = 1..waitlist_count, dense, ordered by (position, created_at)
-- Locking order everywhere: trip row FOR UPDATE first, then booking rows.

-- ---------------------------------------------------------------------------
-- Internal: renumber the waitlist of a trip and refresh waitlist_count.
-- Caller holds the trip row lock.
-- ---------------------------------------------------------------------------
create or replace function public.booking_renumber_waitlist(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  with w as (
    select id,
           row_number() over (order by waitlist_position nulls last, created_at, id)::integer as rn
    from public.bookings
    where trip_id = p_trip_id and status = 'waitlisted'
  )
  update public.bookings b
     set waitlist_position = w.rn
    from w
   where b.id = w.id
     and b.waitlist_position is distinct from w.rn;

  update public.trips t
     set waitlist_count = (select count(*) from public.bookings b where b.trip_id = t.id and b.status = 'waitlisted')
   where t.id = p_trip_id;
end
$$;

revoke all on function public.booking_renumber_waitlist(uuid) from public, anon, authenticated;
grant execute on function public.booking_renumber_waitlist(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Internal: promote the oldest waitlisted booking if a seat is free.
-- Returns the promoted row, or null when nothing was promoted.
-- ---------------------------------------------------------------------------
create or replace function public.booking_promote_next(p_trip_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip    public.trips;
  v_booking public.bookings;
begin
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found or v_trip.confirmed_count >= v_trip.seat_capacity then
    return null;
  end if;

  select * into v_booking
    from public.bookings
   where trip_id = p_trip_id and status = 'waitlisted'
   order by waitlist_position nulls last, created_at, id
   limit 1
   for update;
  if not found then
    return null;
  end if;

  update public.bookings
     set status = 'confirmed',
         waitlist_position = null,
         promoted_at = now()
   where id = v_booking.id
   returning * into v_booking;

  update public.trips set confirmed_count = confirmed_count + 1 where id = p_trip_id;
  perform public.booking_renumber_waitlist(p_trip_id);
  return v_booking;
end
$$;

revoke all on function public.booking_promote_next(uuid) from public, anon, authenticated;
grant execute on function public.booking_promote_next(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- book_seat — reserve a seat (or a waitlist place) for a student on a trip.
-- ---------------------------------------------------------------------------
create or replace function public.book_seat(
  p_user_id            uuid,
  p_trip_id            uuid,
  p_pickup_location_id uuid default null,
  p_pickup_note        text default null,
  p_source             text default 'self'
)
returns public.bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_trip      public.trips;
  v_existing  public.bookings;
  v_booking   public.bookings;
  v_cutoff    integer;
  v_status    public.booking_status;
  v_position  integer;
  v_reuse     boolean := false;
begin
  -- Serialise all bookings on this trip.
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: That departure no longer exists' using errcode = 'P0001';
  end if;

  if v_trip.status not in ('scheduled', 'boarding') or not v_trip.bookings_enabled then
    raise exception 'TRIP_NOT_OPEN: This departure is not open for booking' using errcode = 'P0001';
  end if;

  select booking_cutoff_minutes into v_cutoff from public.settings where id = 1;
  v_cutoff := coalesce(v_cutoff, 5);
  if now() > v_trip.departure_at - make_interval(mins => v_cutoff) then
    raise exception 'BOOKING_CLOSED: Booking closes % min before departure', v_cutoff using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id and is_active) then
    raise exception 'FORBIDDEN: This account is not active' using errcode = 'P0001';
  end if;

  select * into v_existing
    from public.bookings
   where trip_id = p_trip_id and user_id = p_user_id
   for update;
  if found then
    if v_existing.status in ('confirmed', 'waitlisted', 'boarded') then
      raise exception 'ALREADY_BOOKED: You already have a seat on this departure' using errcode = 'P0001';
    end if;
    v_reuse := true;   -- cancelled / no_show row: re-use it (unique (trip_id, user_id))
  end if;

  if p_pickup_location_id is not null and not exists (
    select 1 from public.pickup_locations pl
     where pl.id = p_pickup_location_id
       and pl.is_active
       and (pl.direction is null or pl.direction = v_trip.direction)
  ) then
    raise exception 'PICKUP_INVALID: Pick a valid pickup point for this departure' using errcode = 'P0001';
  end if;

  if v_trip.confirmed_count < v_trip.seat_capacity then
    v_status := 'confirmed';
    v_position := null;
  else
    v_status := 'waitlisted';
    v_position := v_trip.waitlist_count + 1;
  end if;

  if v_reuse then
    update public.bookings
       set status = v_status,
           waitlist_position = v_position,
           pickup_location_id = p_pickup_location_id,
           pickup_note = p_pickup_note,
           agreed_cash_at = now(),
           source = coalesce(p_source, 'self'),
           created_at = now(),
           cancelled_at = null,
           promoted_at = null,
           boarded_at = null
     where id = v_existing.id
     returning * into v_booking;
  else
    insert into public.bookings (trip_id, user_id, pickup_location_id, pickup_note, status, waitlist_position, agreed_cash_at, source)
    values (p_trip_id, p_user_id, p_pickup_location_id, p_pickup_note, v_status, v_position, now(), coalesce(p_source, 'self'))
    returning * into v_booking;
  end if;

  if v_status = 'confirmed' then
    update public.trips set confirmed_count = confirmed_count + 1 where id = p_trip_id;
  else
    update public.trips set waitlist_count = waitlist_count + 1 where id = p_trip_id;
  end if;

  return v_booking;
end
$$;

revoke all on function public.book_seat(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.book_seat(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- cancel_booking — by the owner or any staff member. Frees the seat and promotes
-- the oldest waitlisted rider. Returns {cancelled: row, promoted: row|null}.
-- Idempotent: cancelling an already-cancelled booking returns it unchanged.
-- p_by is informational ('self' | 'driver' | 'admin' | 'system').
-- ---------------------------------------------------------------------------
create or replace function public.cancel_booking(
  p_user_id    uuid,
  p_booking_id uuid,
  p_by         text default 'self'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking  public.bookings;
  v_prev     public.booking_status;
  v_promoted public.bookings;
  v_role     public.user_role;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    raise exception 'NOT_FOUND: Booking not found' using errcode = 'P0001';
  end if;

  if v_booking.user_id is distinct from p_user_id then
    select role into v_role from public.profiles where id = p_user_id;
    if v_role is null or v_role not in ('driver', 'admin') then
      raise exception 'FORBIDDEN: You can only cancel your own booking' using errcode = 'P0001';
    end if;
  end if;

  -- Lock the trip first (same order as book_seat), then re-read the booking.
  perform 1 from public.trips where id = v_booking.trip_id for update;
  select * into v_booking from public.bookings where id = p_booking_id for update;
  v_prev := v_booking.status;

  if v_prev = 'cancelled' then
    return jsonb_build_object('cancelled', to_jsonb(v_booking), 'promoted', null);
  end if;

  update public.bookings
     set status = 'cancelled',
         cancelled_at = now(),
         waitlist_position = null
   where id = v_booking.id
   returning * into v_booking;

  if v_prev in ('confirmed', 'boarded') then
    update public.trips set confirmed_count = greatest(confirmed_count - 1, 0) where id = v_booking.trip_id;
    v_promoted := public.booking_promote_next(v_booking.trip_id);
  elsif v_prev = 'waitlisted' then
    perform public.booking_renumber_waitlist(v_booking.trip_id);
  end if;
  -- no_show already released its seat when it was marked.

  return jsonb_build_object(
    'cancelled', to_jsonb(v_booking),
    'promoted', case when v_promoted.id is null then null else to_jsonb(v_promoted) end
  );
end
$$;

revoke all on function public.cancel_booking(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_booking(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- promote_waitlist — fill every free seat from the waitlist (e.g. after an admin
-- raises seat_capacity). Returns the promoted bookings, oldest first.
-- ---------------------------------------------------------------------------
create or replace function public.promote_waitlist(p_trip_id uuid)
returns setof public.bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_promoted public.bookings;
begin
  perform 1 from public.trips where id = p_trip_id for update;
  if not found then
    raise exception 'NOT_FOUND: Trip not found' using errcode = 'P0001';
  end if;
  loop
    v_promoted := public.booking_promote_next(p_trip_id);
    exit when v_promoted.id is null;
    return next v_promoted;
  end loop;
  return;
end
$$;

revoke all on function public.promote_waitlist(uuid) from public, anon, authenticated;
grant execute on function public.promote_waitlist(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- set_booking_status — driver/admin transitions.
--   boarded   : confirmed → boarded (seat kept); waitlisted → boarded (leaves the
--               waitlist, takes a seat — the driver decides); no_show → boarded.
--   no_show   : confirmed/boarded → no_show (seat released, NOT auto-promoted:
--               call promote_waitlist() if you want to fill it); waitlisted → no_show.
--   confirmed : boarded → confirmed (undo), no_show/cancelled → confirmed (re-seat),
--               waitlisted → confirmed (manual promotion).
--   cancelled : delegates to cancel_booking (promotes the next waitlisted rider).
-- p_actor is the staff profile acting (null = system). Counters stay exact.
-- ---------------------------------------------------------------------------
create or replace function public.set_booking_status(
  p_booking_id uuid,
  p_status     public.booking_status,
  p_actor      uuid default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking   public.bookings;
  v_prev      public.booking_status;
  v_seat_before boolean;
  v_seat_after  boolean;
  v_wait_before boolean;
  v_wait_after  boolean;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then
    raise exception 'NOT_FOUND: Booking not found' using errcode = 'P0001';
  end if;

  if p_status = 'cancelled' then
    perform public.cancel_booking(coalesce(p_actor, v_booking.user_id), p_booking_id,
                                  case when p_actor is null then 'system' else 'staff' end);
    select * into v_booking from public.bookings where id = p_booking_id;
    return v_booking;
  end if;

  if p_status = 'waitlisted' then
    raise exception 'CONFLICT: A booking cannot be moved back to the waitlist' using errcode = 'P0001';
  end if;

  perform 1 from public.trips where id = v_booking.trip_id for update;
  select * into v_booking from public.bookings where id = p_booking_id for update;
  v_prev := v_booking.status;

  if v_prev = p_status then
    return v_booking;
  end if;

  if v_prev = 'cancelled' and p_status <> 'confirmed' then
    raise exception 'CONFLICT: Re-seat a cancelled booking before marking it %', p_status using errcode = 'P0001';
  end if;

  v_seat_before := v_prev in ('confirmed', 'boarded');
  v_seat_after  := p_status in ('confirmed', 'boarded');
  v_wait_before := v_prev = 'waitlisted';
  v_wait_after  := false;

  update public.bookings
     set status = p_status,
         waitlist_position = null,
         boarded_at = case when p_status = 'boarded' then now() else null end,
         promoted_at = case when v_wait_before and v_seat_after then now() else promoted_at end,
         cancelled_at = case when v_prev = 'cancelled' then null else cancelled_at end,
         agreed_cash_at = case when v_prev = 'cancelled' then now() else agreed_cash_at end
   where id = p_booking_id
   returning * into v_booking;

  if v_seat_after and not v_seat_before then
    update public.trips set confirmed_count = confirmed_count + 1 where id = v_booking.trip_id;
  elsif v_seat_before and not v_seat_after then
    update public.trips set confirmed_count = greatest(confirmed_count - 1, 0) where id = v_booking.trip_id;
  end if;

  if v_wait_before and not v_wait_after then
    perform public.booking_renumber_waitlist(v_booking.trip_id);
  end if;

  return v_booking;
end
$$;

revoke all on function public.set_booking_status(uuid, public.booking_status, uuid) from public, anon, authenticated;
grant execute on function public.set_booking_status(uuid, public.booking_status, uuid) to service_role;
