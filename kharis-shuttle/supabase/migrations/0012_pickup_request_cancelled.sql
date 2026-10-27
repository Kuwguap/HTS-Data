-- 0012 — new notification kind: the driver hears when a rider withdraws a pickup
-- request they had already ACCEPTED (POST /api/pickup-requests/[id]/cancel).
--
-- A value added to an enum cannot be used inside the same transaction that adds it
-- (Postgres: "unsafe use of new value"), and message_templates.key is of type
-- notification_kind, so the template row lives in the next migration
-- (0013_pickup_request_cancelled_template.sql). Keep the two files separate.
alter type public.notification_kind add value if not exists 'pickup_request_cancelled';
