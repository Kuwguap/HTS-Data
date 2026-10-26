-- 0007_realtime.sql — live bus position (broadcast) + change-signal publication.
--
-- * Every trip_locations insert broadcasts the fix on the private topic 'trip:<trip_id>'
--   via realtime.send(); trips.last_* is refreshed at most every 15 s (newest wins).
--   The broadcast is wrapped so a Realtime hiccup never loses the GPS row.
-- * trips / bookings / pickup_requests / notifications go into the supabase_realtime
--   publication (clients use postgres_changes purely as an invalidation signal).
-- * authenticated users may read broadcast messages on 'trip:%' topics.

create or replace function public.trip_locations_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- trips is in the realtime publication, so every UPDATE here fans out to every
  -- student page as a refresh signal. Fold position updates to at most one per
  -- 15 s per trip (the per-fix broadcast below still carries every point live).
  update public.trips
     set last_lat = new.lat,
         last_lng = new.lng,
         last_heading = new.heading,
         last_speed_mps = new.speed_mps,
         last_location_at = new.recorded_at
   where id = new.trip_id
     and (last_location_at is null or last_location_at + interval '15 seconds' <= new.recorded_at);

  begin
    perform realtime.send(
      jsonb_build_object(
        'trip_id', new.trip_id,
        'lat', new.lat,
        'lng', new.lng,
        'heading', new.heading,
        'speed_mps', new.speed_mps,
        'accuracy_m', new.accuracy_m,
        'recorded_at', new.recorded_at
      ),
      'location',
      'trip:' || new.trip_id::text,
      true
    );
  exception when others then
    -- Never fail the insert because the broadcast failed (students poll as fallback).
    null;
  end;

  return new;
end
$$;

drop trigger if exists trip_locations_after_insert on public.trip_locations;
create trigger trip_locations_after_insert
  after insert on public.trip_locations
  for each row execute function public.trip_locations_after_insert();

-- Publication membership (only when Supabase's publication exists).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['trips', 'bookings', 'pickup_requests', 'notifications'] loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end
$$;

-- Old-row data for postgres_changes DELETE/UPDATE filtering under RLS (small tables only).
alter table public.bookings        replica identity full;
alter table public.pickup_requests replica identity full;
alter table public.notifications   replica identity full;

-- Private broadcast channel policy: signed-in users can listen to any trip's
-- location topic (trips themselves are readable by every authenticated user).
do $$
begin
  if to_regclass('realtime.messages') is not null then
    begin
      execute 'drop policy if exists "trip location broadcast" on realtime.messages';
      execute $p$
        create policy "trip location broadcast" on realtime.messages
          for select to authenticated
          using (realtime.topic() like 'trip:%' and extension = 'broadcast')
      $p$;
    exception when others then
      raise notice 'realtime.messages policy not created: %', sqlerrm;
    end;
  end if;
end
$$;
