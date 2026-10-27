-- 0011_reseat_guard.sql — re-seating a no_show / cancelled rider must not overbook.
--
-- The driver marks a confirmed rider no_show on a full trip; the route handler then
-- calls promote_waitlist(), which hands the freed seat to the next waitlisted rider.
-- When the driver taps "Undo" the handler calls set_booking_status(..., 'confirmed'):
-- the no_show → confirmed (and cancelled → confirmed) branch used to increment
-- confirmed_count blindly, so the trip ended up at seat_capacity + 1.
--
-- This re-creates set_booking_status with one change: when the previous status is
-- no_show or cancelled and the target is confirmed, the (locked) trip must still have
-- a free seat, otherwise 'CONFLICT: Trip is full — the seat went to the waitlist' is
-- raised (fromPostgresError → 409). The deliberate driver overrides stay as they were:
-- waitlisted → boarded and no_show → boarded still take a seat regardless of capacity
-- (the driver decides who is on the bus), and boarded → confirmed keeps its seat.
-- Everything else is a verbatim copy of 0003_fn_booking.sql.

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
  v_trip      public.trips;
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

  -- Lock the trip first (same order as book_seat); its counters are read below.
  select * into v_trip from public.trips where id = v_booking.trip_id for update;
  select * into v_booking from public.bookings where id = p_booking_id for update;
  v_prev := v_booking.status;

  if v_prev = p_status then
    return v_booking;
  end if;

  if v_prev = 'cancelled' and p_status <> 'confirmed' then
    raise exception 'CONFLICT: Re-seat a cancelled booking before marking it %', p_status using errcode = 'P0001';
  end if;

  -- Re-seating (the "Undo" after a no_show, or seating a cancelled rider again) needs a
  -- free seat: the released one may already have gone to the waitlist.
  if v_prev in ('no_show', 'cancelled') and p_status = 'confirmed'
     and v_trip.confirmed_count >= v_trip.seat_capacity then
    raise exception 'CONFLICT: Trip is full — the seat went to the waitlist' using errcode = 'P0001';
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
