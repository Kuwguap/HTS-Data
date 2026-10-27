-- 0013 — default template for pickup_request_cancelled (enum value added in 0012; it
-- must be committed before this row can reference it). Placeholders follow
-- render_text() in 0004_fn_notify.sql; the cancel route passes {name} and {pickup}.
-- Mirrored in src/lib/data/template-defaults.ts.
insert into public.message_templates (key, title, body) values
  ('pickup_request_cancelled', '🙅 Pickup request withdrawn', '{name} no longer needs a pickup at {pickup}.')
on conflict (key) do nothing;
