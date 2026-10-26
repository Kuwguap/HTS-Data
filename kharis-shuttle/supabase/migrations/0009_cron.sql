-- 0009_cron.sql — the minute ticker (Supabase only).
--
-- Guarded: the whole file is a no-op unless BOTH pg_cron and pg_net are installed
-- (Dashboard → Database → Extensions, or `create extension pg_cron; create extension pg_net;`).
-- Locally (scripts/local-pg.sh) neither exists, so nothing happens.
--
-- cron_tick():
--   1. run_tick()            — all SQL-side work (materialise, enqueue, expire, cleanup)
--   2. net.http_post(...)    — wakes the web app's POST /api/cron/tick, which drains
--                              the push outbox with web-push. Needs two Vault secrets:
--        select vault.create_secret('https://<your-app>/api/cron/tick', 'tick_url');
--        select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--      Without them (or if the hop fails) the SQL side still runs every minute; the
--      outbox is drained the next time the app is hit or by a backup cron-job.org call.
do $$
begin
  if not (
    exists (select 1 from pg_extension where extname = 'pg_cron')
    and exists (select 1 from pg_extension where extname = 'pg_net')
  ) then
    raise notice '0009_cron.sql skipped: pg_cron and/or pg_net not installed';
    return;
  end if;

  execute $fn$
    create or replace function public.cron_tick()
    returns void
    language plpgsql
    security definer
    set search_path = public, extensions
    as $body$
    declare
      v_url    text;
      v_secret text;
    begin
      perform public.run_tick(now());

      begin
        if to_regclass('vault.decrypted_secrets') is not null then
          select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'tick_url'    limit 1;
          select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
          if v_url is not null and v_secret is not null then
            perform net.http_post(
              url := v_url,
              headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_secret
              ),
              body := jsonb_build_object('source', 'pg_cron', 'at', now()),
              timeout_milliseconds := 8000
            );
          end if;
        end if;
      exception when others then
        -- The web hop is best-effort; never let it fail the cron job.
        raise warning 'cron_tick: web hop failed: %', sqlerrm;
      end;
    end
    $body$;
  $fn$;

  execute 'revoke all on function public.cron_tick() from public, anon, authenticated';
  execute 'grant execute on function public.cron_tick() to service_role';

  -- Every minute. Unschedule first so re-applying the migration is safe.
  if exists (select 1 from cron.job where jobname = 'kharis-tick') then
    perform cron.unschedule('kharis-tick');
  end if;
  perform cron.schedule('kharis-tick', '* * * * *', $job$ select public.cron_tick(); $job$);

  -- Keep cron.job_run_details small: daily at 03:00 (server time) drop rows > 7 days.
  if exists (select 1 from cron.job where jobname = 'kharis-cron-cleanup') then
    perform cron.unschedule('kharis-cron-cleanup');
  end if;
  perform cron.schedule(
    'kharis-cron-cleanup',
    '0 3 * * *',
    $job$ delete from cron.job_run_details where end_time < now() - interval '7 days'; $job$
  );
end
$$;
