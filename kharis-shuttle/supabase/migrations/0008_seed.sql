-- 0008_seed.sql — reference data. Safe to re-apply (on conflict do nothing); admins
-- edit everything here from /admin afterwards, so re-running never overwrites edits.

-- Settings singleton.
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Message templates: one per notification_kind. Placeholders: {hostel} {campus} {time}
-- {date} {times} {fare} {seats_left} {seats} {pickup} {name} {origin} {destination}
-- {count} {summary} {message} {title}. Unknown placeholders render as ''.
insert into public.message_templates (key, title, body) values
  ('daily_announcement',      '🚌 Shuttle today',                 'Departures: {times}. Fare {fare}, cash only. Tap to book your seat.'),
  ('trip_reminder',           '🚌 Shuttle at {time}',             '{seats_left}/{seats} seats left. {fare} cash. Tap to opt in.'),
  ('trip_nudge',              '⏰ Leaving in {count} min',        'Be at {pickup}. Have {fare} cash ready.'),
  ('trip_departed',           '🚌 Shuttle has left',              'The {time} shuttle to {destination} has departed.'),
  ('booking_confirmed',       '✅ Seat reserved',                 'You''re on the {time} shuttle to {destination}. Pickup: {pickup}. {fare} cash.'),
  ('booking_waitlisted',      '⏳ You''re on the waitlist',       'Position {count} for the {time} shuttle. We''ll tell you if a seat opens.'),
  ('booking_promoted',        '🎉 A seat opened up',              'You''re now confirmed for the {time} shuttle to {destination}. Be at {pickup}.'),
  ('booking_cancelled',       '❌ Booking cancelled',             'Your seat on the {time} shuttle to {destination} was cancelled. {message}'),
  ('trip_cancelled',          '⚠️ Shuttle cancelled',             'The {time} shuttle to {destination} is cancelled. {message}'),
  ('trip_updated',            '🔄 Shuttle updated',               'The {time} shuttle to {destination} has changed. {message}'),
  ('driver_manifest',         '📋 {time} to {destination}',       '{count} riders — {summary}'),
  ('driver_booking_update',   '💺 Booking update',                '{name} {message} ({pickup}) for the {time} shuttle.'),
  ('pickup_request_new',      '✋ Pickup request',                '{name} at {pickup}. {message}'),
  ('pickup_request_accepted', '✅ Pickup accepted',               'Wait at {pickup}. {message}'),
  ('pickup_request_declined', '❌ Pickup declined',               '{message}'),
  ('pickup_request_expired',  '⌛ Pickup request expired',        'Nobody responded to your request at {pickup}. Try again or call the office.'),
  ('return_announcement',     '🚌 Shuttle heading to {hostel}',   'Shuttle at {origin} → {hostel}. Leaving in {count} min. Tap if you''re coming.'),
  ('broadcast',               '📣 {title}',                       '{message}'),
  ('test',                    '🔔 Notifications are on',          'You''ll get shuttle reminders here, {name}.')
on conflict (key) do nothing;

-- Default pickup points for Kharis Courts Hostel / KNUST (Kumasi).
-- Coordinates are APPROXIMATE placeholders near 6.67, -1.57 — edit them in
-- /admin/locations (map picker) before go-live. Fixed ids keep re-seeding idempotent.
insert into public.pickup_locations (id, name, description, direction, lat, lng, sort_order) values
  ('11111111-0000-4000-8000-000000000001', 'Hostel main gate',  'Kharis Courts Hostel, main gate',          'to_campus', 6.6760, -1.5720, 10),
  ('11111111-0000-4000-8000-000000000002', 'Hostel car park',   'Inside the hostel, by the car park',       'to_campus', 6.6765, -1.5715, 20),
  ('11111111-0000-4000-8000-000000000003', 'KSB (campus)',      'KNUST School of Business, front',          'to_hostel', 6.6693, -1.5673, 30),
  ('11111111-0000-4000-8000-000000000004', 'Commercial Area',   'KNUST Commercial Area, by the bank',       'to_hostel', 6.6749, -1.5728, 40)
on conflict (id) do nothing;

-- Default timetable (Mon–Fri). to_campus: 7:30, 9:30, 11:30 AM, 1:30, 3:30 PM;
-- to_hostel: 12:30, 2:30, 4:30, 6:30 PM.
insert into public.schedule_times (direction, depart_time, days_of_week, label) values
  ('to_campus', '07:30', '{1,2,3,4,5}', 'Morning'),
  ('to_campus', '09:30', '{1,2,3,4,5}', null),
  ('to_campus', '11:30', '{1,2,3,4,5}', null),
  ('to_campus', '13:30', '{1,2,3,4,5}', null),
  ('to_campus', '15:30', '{1,2,3,4,5}', null),
  ('to_hostel', '12:30', '{1,2,3,4,5}', null),
  ('to_hostel', '14:30', '{1,2,3,4,5}', null),
  ('to_hostel', '16:30', '{1,2,3,4,5}', null),
  ('to_hostel', '18:30', '{1,2,3,4,5}', 'Last return')
on conflict (direction, depart_time) do nothing;
