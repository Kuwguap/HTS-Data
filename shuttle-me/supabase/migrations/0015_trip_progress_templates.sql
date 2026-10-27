-- 0015 — default templates for the kinds added in 0014 (they must be committed before
-- this file can reference them). Placeholders follow render_text() in 0004_fn_notify.sql;
-- the driver status / location routes pass {time}, {origin}, {destination}, {pickup}
-- and {count} (minutes). Mirrored in src/lib/data/template-defaults.ts.
insert into public.message_templates (key, title, body) values
  ('trip_boarding',    '🚌 Boarding now',     'The {time} shuttle is boarding at {origin}. Be at {pickup} — leaves at {time}.'),
  ('trip_approaching', '🚌 Shuttle is close', 'The shuttle is about {count} min from {pickup}. Head there now.'),
  ('trip_arrived',     '🏁 Arrived',          'The {time} shuttle has arrived at {destination}.')
on conflict (key) do nothing;

-- trip_departed now opens the live map: refresh its default body, but only where the
-- stored body is still the 0008 default so an admin's own wording survives.
update public.message_templates
   set body = 'The {time} shuttle to {destination} has left {origin} — tap to follow it live.'
 where key = 'trip_departed'
   and body = 'The {time} shuttle to {destination} has departed.';
