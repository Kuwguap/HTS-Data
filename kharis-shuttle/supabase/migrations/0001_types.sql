-- 0001_types.sql — extensions + enums.
--
-- Applies to the hosted Supabase project and to the local plain Postgres 16 used by
-- the SQL tests (scripts/local-pg.sh applies scripts/pg-shims.sql first).

-- pgcrypto: on Supabase it lives in the `extensions` schema; locally the shim already
-- created it in `public`. `create extension if not exists` only checks the name, so
-- either placement is fine — the DO block just picks the right schema when it is
-- genuinely missing. (gen_random_uuid() itself is built into PG13+.)
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      execute 'create extension pgcrypto with schema extensions';
    else
      execute 'create extension pgcrypto';
    end if;
  end if;
end
$$;

-- Enums (values must match src/lib/db.types.ts exactly).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('student', 'driver', 'admin');
  end if;
  if not exists (select 1 from pg_type where typname = 'trip_direction') then
    create type public.trip_direction as enum ('to_campus', 'to_hostel');
  end if;
  if not exists (select 1 from pg_type where typname = 'trip_status') then
    create type public.trip_status as enum ('scheduled', 'boarding', 'departed', 'arrived', 'cancelled', 'expired');
  end if;
  if not exists (select 1 from pg_type where typname = 'booking_status') then
    create type public.booking_status as enum ('confirmed', 'waitlisted', 'cancelled', 'boarded', 'no_show');
  end if;
  if not exists (select 1 from pg_type where typname = 'pickup_request_status') then
    create type public.pickup_request_status as enum ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'completed');
  end if;
  if not exists (select 1 from pg_type where typname = 'push_status') then
    create type public.push_status as enum ('pending', 'sending', 'sent', 'failed', 'skipped');
  end if;
  if not exists (select 1 from pg_type where typname = 'notification_kind') then
    create type public.notification_kind as enum (
      'daily_announcement',
      'trip_reminder',
      'trip_nudge',
      'trip_departed',
      'booking_confirmed',
      'booking_waitlisted',
      'booking_promoted',
      'booking_cancelled',
      'trip_cancelled',
      'trip_updated',
      'driver_manifest',
      'driver_booking_update',
      'pickup_request_new',
      'pickup_request_accepted',
      'pickup_request_declined',
      'pickup_request_expired',
      'return_announcement',
      'broadcast',
      'test'
    );
  end if;
end
$$;
