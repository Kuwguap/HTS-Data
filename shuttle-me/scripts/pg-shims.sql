-- Shims that make a plain Postgres 16 look enough like a Supabase project for the
-- migrations in supabase/migrations to apply and for RLS tests to run.
-- Idempotent: safe to run on every `local-pg.sh up`.
--
-- What Supabase provides that we stub here:
--   * roles anon / authenticated / service_role (service_role bypasses RLS)
--   * schema auth with auth.users, auth.uid(), auth.jwt(), auth.role()
--   * schema realtime with realtime.send(...) writing to a realtime.messages table
--   * schema extensions (pgcrypto lives there on Supabase)
-- pg_cron / pg_net / vault are NOT stubbed: migration 0009_cron.sql guards on their
-- presence and becomes a no-op locally.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- Let the test runner (connected as postgres) switch into these roles.
grant anon, authenticated, service_role to postgres;

create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists realtime;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema realtime to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on auth.users to authenticated, service_role;

-- NB: once a custom GUC has been SET LOCAL in a session, current_setting() returns ''
-- (not NULL) after the transaction ends, so every read goes through nullif(..., '')
-- before the jsonb cast — exactly like the real Supabase helpers.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    ''
  )::text
$$;

grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;

-- Realtime broadcast stub: realtime.send() on Supabase inserts into realtime.messages.
create table if not exists realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text not null default 'broadcast',
  event text,
  payload jsonb,
  private boolean not null default false,
  inserted_at timestamptz not null default now()
);
grant select, insert on realtime.messages to anon, authenticated, service_role;
-- Supabase ships realtime.messages with RLS enabled; 0007_realtime.sql adds the policy.
alter table realtime.messages enable row level security;

create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language plpgsql
as $$
begin
  insert into realtime.messages (topic, extension, event, payload, private)
  values (topic, 'broadcast', event, payload, private);
end
$$;
grant execute on function realtime.send(jsonb, text, text, boolean) to anon, authenticated, service_role;

-- Supabase exposes realtime.topic() inside realtime.messages policies.
create or replace function realtime.topic() returns text
language sql stable
as $$ select nullif(current_setting('realtime.topic', true), '') $$;
grant execute on function realtime.topic() to anon, authenticated, service_role;

-- Test helper: impersonate a user the way PostgREST does.
create or replace function public.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', p_role, true);
end
$$;
