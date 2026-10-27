-- 0014 — three notification kinds for live trip progress, sent by the driver routes:
--   trip_boarding    → confirmed riders when the driver taps Boarding
--   trip_approaching → a confirmed rider when the bus comes within 400 m of their pickup
--   trip_arrived     → boarded riders when the driver taps Arrived
--
-- A value added to an enum cannot be used inside the transaction that adds it
-- (Postgres: "unsafe use of new value"), and message_templates.key is of type
-- notification_kind, so the template rows live in the next migration
-- (0015_trip_progress_templates.sql). Keep the two files separate; nothing else here.
alter type public.notification_kind add value if not exists 'trip_boarding';
alter type public.notification_kind add value if not exists 'trip_approaching';
alter type public.notification_kind add value if not exists 'trip_arrived';
