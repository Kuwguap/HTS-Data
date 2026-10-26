-- seed.local.sql — test fixtures for the local Postgres (NOT applied by local-pg.sh;
-- tests/sql/helpers.ts applies it after `local-pg.sh reset`). Never run on Supabase.
--
-- Inserting into auth.users fires handle_new_user(), which creates the profiles.
-- Fixed ids so tests can reference them:
--   admin    aaaaaaaa-0000-4000-8000-000000000001  (ama_admin)
--   driver   dddddddd-0000-4000-8000-000000000001  (kofi_driver)
--   students 55555555-0000-4000-8000-00000000000{1,2,3} (abena, yaw, efua)

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'ama_admin@users.kharis-shuttle.local', now(),
   '{"username":"ama_admin","full_name":"Ama Mensah","phone":"+233200000001","room":"Office"}', '{"role":"admin"}'),
  ('dddddddd-0000-4000-8000-000000000001', 'kofi_driver@users.kharis-shuttle.local', now(),
   '{"username":"kofi_driver","full_name":"Kofi Boateng","phone":"+233200000002"}', '{"role":"driver"}'),
  ('55555555-0000-4000-8000-000000000001', 'abena@users.kharis-shuttle.local', now(),
   '{"username":"abena","full_name":"Abena Owusu","phone":"+233200000011","room":"A12"}', '{}'),
  ('55555555-0000-4000-8000-000000000002', 'yaw@users.kharis-shuttle.local', now(),
   '{"username":"yaw","full_name":"Yaw Darko","room":"B7"}', '{}'),
  ('55555555-0000-4000-8000-000000000003', 'efua@users.kharis-shuttle.local', now(),
   '{"username":"efua","full_name":"Efua Asante","room":"C3"}', '{}')
on conflict (id) do nothing;
