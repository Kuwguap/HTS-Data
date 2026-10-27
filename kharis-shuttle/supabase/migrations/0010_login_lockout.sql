-- 0010_login_lockout.sql — atomic PIN brute-force counter.
--
-- recordLoginFailure() used to be select-then-upsert from the app: two PostgREST
-- calls with no lock, so a burst of parallel wrong-PIN requests only counted as
-- three or four failures and slipped past the 5-per-15-min lockout. A single
-- INSERT ... ON CONFLICT DO UPDATE serialises on the username row instead:
-- concurrent callers queue on the row lock and each one sees the previous count.
--
--   (a) while locked_until > now()           → row unchanged (still locked)
--   (b) otherwise                            → failed_count + 1
--   (c) when that reaches p_max_failures     → failed_count = 0, locked_until = now() + p_lockout_minutes
--
-- Service role only (same as the login_attempts table it guards).

create or replace function public.record_login_failure(
  p_username        text,
  p_max_failures    integer default 5,
  p_lockout_minutes integer default 15
)
returns public.login_attempts
language sql
security definer
set search_path = public
as $$
  insert into public.login_attempts as la (username, failed_count, locked_until, updated_at)
  values (
    p_username,
    case when 1 >= p_max_failures then 0 else 1 end,
    case when 1 >= p_max_failures then now() + p_lockout_minutes * interval '1 minute' end,
    now()
  )
  on conflict (username) do update set
    failed_count = case
      when la.locked_until > now()                  then la.failed_count      -- (a) still locked
      when la.failed_count + 1 >= p_max_failures    then 0                    -- (c) lockout tripped
      else                                               la.failed_count + 1  -- (b) one more strike
    end,
    locked_until = case
      when la.locked_until > now()                  then la.locked_until
      when la.failed_count + 1 >= p_max_failures    then now() + p_lockout_minutes * interval '1 minute'
      else                                               null
    end,
    updated_at = now()
  returning *;
$$;

comment on function public.record_login_failure(text, integer, integer) is
  'Atomic wrong-PIN counter: increments failed_count, locks the username for p_lockout_minutes once p_max_failures is reached, and is a no-op while locked. Returns the login_attempts row.';

revoke all on function public.record_login_failure(text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_login_failure(text, integer, integer) to service_role;
