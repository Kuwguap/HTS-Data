-- 0016: where the hostel and the campus are, so the live map can draw the shuttle's
-- road route ahead of the bus (GET /api/trips/[id]/route). Both pairs are optional:
-- when unset the route falls back to the first active pickup point on the far side
-- (see src/lib/trips/endpoints.ts). Same range checks as pickup_locations.

alter table public.settings
  add column if not exists hostel_lat double precision,
  add column if not exists hostel_lng double precision,
  add column if not exists campus_lat double precision,
  add column if not exists campus_lng double precision;

alter table public.settings drop constraint if exists settings_hostel_lat_range;
alter table public.settings add constraint settings_hostel_lat_range check (hostel_lat is null or hostel_lat between -90 and 90);
alter table public.settings drop constraint if exists settings_hostel_lng_range;
alter table public.settings add constraint settings_hostel_lng_range check (hostel_lng is null or hostel_lng between -180 and 180);
alter table public.settings drop constraint if exists settings_campus_lat_range;
alter table public.settings add constraint settings_campus_lat_range check (campus_lat is null or campus_lat between -90 and 90);
alter table public.settings drop constraint if exists settings_campus_lng_range;
alter table public.settings add constraint settings_campus_lng_range check (campus_lng is null or campus_lng between -180 and 180);

comment on column public.settings.hostel_lat is 'Hostel position (with hostel_lng); destination of to_hostel trips on the live map.';
comment on column public.settings.campus_lat is 'Campus position (with campus_lng); destination of to_campus trips on the live map.';

-- Same column-level visibility as the other public settings (0006): nothing secret here.
grant select (hostel_lat, hostel_lng, campus_lat, campus_lng) on public.settings to authenticated;
