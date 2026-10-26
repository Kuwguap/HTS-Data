-- 0004_fn_notify.sql — templates, the notifications outbox and the claim/finish cycle
-- used by the Node drain (POST /api/cron/tick → drainOutbox()).

-- ---------------------------------------------------------------------------
-- format_fare — 1000 → 'GH₵10', 1250 → 'GH₵12.50' (mirrors src/lib/time.ts formatFare)
-- ---------------------------------------------------------------------------
create or replace function public.format_fare(p_pesewas integer, p_currency text default 'GHS')
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case when coalesce(p_currency, 'GHS') = 'GHS' then 'GH₵' else p_currency || ' ' end
      || case when p_pesewas % 100 = 0
              then (p_pesewas / 100)::text
              else to_char(p_pesewas / 100.0, 'FM999999990.00')
         end;
$$;

-- ---------------------------------------------------------------------------
-- format_local_time — '7:30 AM' in settings.timezone
-- ---------------------------------------------------------------------------
create or replace function public.format_local_time(p_at timestamptz)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select to_char(p_at at time zone coalesce((select timezone from public.settings where id = 1), 'Africa/Accra'),
                 'FMHH12:MI AM');
$$;

-- ---------------------------------------------------------------------------
-- render_text — single-pass {placeholder} substitution (mirrors src/lib/notify/template.ts).
-- The ORIGINAL template is tokenised once into placeholders / literal runs, so a value
-- that itself contains '{message}' is emitted verbatim and never re-expanded.
-- Unknown placeholders → ''. Runs of spaces/tabs collapse to one space; newlines are kept.
-- ---------------------------------------------------------------------------
create or replace function public.render_text(p_template text, p_vars jsonb)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select regexp_replace(
           regexp_replace(
             coalesce((
               select string_agg(
                        case when m.tok[1] is not null
                             then coalesce(p_vars ->> substr(m.tok[1], 2, length(m.tok[1]) - 2), '')
                             else m.tok[2]
                        end,
                        '' order by m.ord)
                 from regexp_matches(coalesce(p_template, ''), '(\{[a-zA-Z0-9_]+\})|([^{]+|\{)', 'g')
                      with ordinality as m(tok, ord)
             ), ''),
             '[ \t]{2,}', ' ', 'g'),
           '^\s+|\s+$', '', 'g');
$$;

revoke all on function public.render_text(text, jsonb) from public, anon, authenticated;
grant execute on function public.render_text(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- render_template — fill {placeholders} of a message_templates row via render_text().
-- Falls back to the kind name as title when the template row is missing.
-- ---------------------------------------------------------------------------
create or replace function public.render_template(p_kind public.notification_kind, p_vars jsonb)
returns table (title text, body text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_title text;
  v_body  text;
begin
  select t.title, t.body into v_title, v_body from public.message_templates t where t.key = p_kind;
  if not found then
    v_title := replace(p_kind::text, '_', ' ');
    v_body  := '';
  end if;

  title := public.render_text(v_title, coalesce(p_vars, '{}'::jsonb));
  body  := public.render_text(v_body,  coalesce(p_vars, '{}'::jsonb));
  return next;
end
$$;

revoke all on function public.render_template(public.notification_kind, jsonb) from public, anon, authenticated;
grant execute on function public.render_template(public.notification_kind, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- enqueue_notification — one inbox/outbox row per recipient, deduplicated by
-- p_dedupe_prefix || ':' || user_id. Inactive profiles are skipped. Returns the number
-- of rows actually inserted (0 when every recipient already had it).
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_notification(
  p_user_ids      uuid[],
  p_kind          public.notification_kind,
  p_vars          jsonb,
  p_url           text default null,
  p_dedupe_prefix text default null,
  p_ttl_seconds   integer default 3600,
  p_urgency       text default 'normal',
  p_collapse_tag  text default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title text;
  v_body  text;
  v_count integer := 0;
  v_prefix text;
begin
  if p_user_ids is null or cardinality(p_user_ids) = 0 then
    return 0;
  end if;
  v_prefix := coalesce(nullif(p_dedupe_prefix, ''), p_kind::text || ':' || gen_random_uuid()::text);

  select r.title, r.body into v_title, v_body from public.render_template(p_kind, coalesce(p_vars, '{}'::jsonb)) r;

  insert into public.notifications (user_id, kind, title, body, url, data, dedupe_key, ttl_seconds, urgency, collapse_tag)
  select p.id, p_kind, v_title, v_body, p_url, coalesce(p_vars, '{}'::jsonb),
         v_prefix || ':' || p.id::text,
         greatest(coalesce(p_ttl_seconds, 3600), 60),
         case when p_urgency in ('very-low', 'low', 'normal', 'high') then p_urgency else 'normal' end,
         p_collapse_tag
    from public.profiles p
   where p.id = any (select distinct u from unnest(p_user_ids) as u)
     and p.is_active
  on conflict (dedupe_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.enqueue_notification(uuid[], public.notification_kind, jsonb, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_notification(uuid[], public.notification_kind, jsonb, text, text, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- claim_pending_notifications — atomically take up to p_limit rows for sending.
-- Takes 'pending' rows that were never claimed, or whose last claim is > 45 s old
-- (a row handed back with finish_notification(…, 'pending') keeps push_claimed_at, so
-- the same drain run never re-serves it — the retry waits for the next run), plus
-- 'sending' rows stuck for > 2 minutes (crashed drain). Marks them sending, bumps
-- push_attempts and returns them with the recipient's active push subscriptions as a
-- jsonb array ([] → caller marks the row skipped). push_attempts is the value AFTER the
-- bump (1 on the first delivery attempt). Rows that already failed 5 times are left
-- alone (run_tick marks them failed).
-- ---------------------------------------------------------------------------
drop function if exists public.claim_pending_notifications(integer);
create function public.claim_pending_notifications(p_limit integer default 100)
returns table (
  id            uuid,
  user_id       uuid,
  kind          public.notification_kind,
  title         text,
  body          text,
  url           text,
  data          jsonb,
  ttl_seconds   integer,
  urgency       text,
  collapse_tag  text,
  push_attempts integer,
  subscriptions jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  with picked as (
    select n.id
      from public.notifications n
     where ((n.push_status = 'pending'
             and (n.push_claimed_at is null or n.push_claimed_at < now() - interval '45 seconds'))
            or (n.push_status = 'sending' and n.push_claimed_at < now() - interval '2 minutes'))
       and n.push_attempts < 5
       and n.created_at + make_interval(secs => n.ttl_seconds) > now()
     order by n.created_at
     limit greatest(coalesce(p_limit, 100), 1)
     for update skip locked
  ),
  claimed as (
    update public.notifications n
       set push_status = 'sending',
           push_claimed_at = now(),
           push_attempts = n.push_attempts + 1
      from picked
     where n.id = picked.id
    returning n.id, n.user_id, n.kind, n.title, n.body, n.url, n.data, n.ttl_seconds, n.urgency, n.collapse_tag,
              n.push_attempts, n.created_at
  )
  select c.id, c.user_id, c.kind, c.title, c.body, c.url, c.data, c.ttl_seconds, c.urgency, c.collapse_tag,
         c.push_attempts,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                            order by s.last_seen_at desc)
             from public.push_subscriptions s
            where s.user_id = c.user_id and s.disabled_at is null
         ), '[]'::jsonb) as subscriptions
    from claimed c
   order by c.created_at;
end
$$;

revoke all on function public.claim_pending_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer) to service_role;

-- ---------------------------------------------------------------------------
-- finish_notification — record the push outcome. 'pending' re-queues for a retry but
-- KEEPS push_claimed_at, so claim_pending_notifications() ignores the row for 45 s
-- (i.e. the drain run that just handed it back cannot pick it up again).
-- ---------------------------------------------------------------------------
create or replace function public.finish_notification(
  p_id     uuid,
  p_status public.push_status,
  p_error  text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.notifications
     set push_status = p_status,
         push_sent_at = case when p_status = 'sent' then now() else push_sent_at end,
         push_error = case when p_status = 'sent' then null else left(p_error, 500) end
   where id = p_id;
end
$$;

revoke all on function public.finish_notification(uuid, public.push_status, text) from public, anon, authenticated;
grant execute on function public.finish_notification(uuid, public.push_status, text) to service_role;

-- ---------------------------------------------------------------------------
-- mark_notifications_read — callable by signed-in users; only touches their rows.
-- ---------------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_ids is null then
    return;
  end if;
  update public.notifications
     set read_at = now()
   where user_id = v_uid
     and read_at is null
     and id = any (p_ids);
end
$$;

revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated, service_role;
