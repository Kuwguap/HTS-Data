# Shuttle Me — Kharis Courts Hostel shuttle app

A progressive web app (install from Safari with **Share → Add to Home Screen**) that replaces the
morning WhatsApp announcement and the "shuttle is at KSB" messages with:

- automatic **push reminders** before each departure so students opt in for a seat,
- one-tap **seat reservations** (pick a pickup point, agree to pay the GH₵ fare in cash),
- a live **manifest and notifications for the driver**,
- **live bus tracking** on a map while the driver keeps the app open — the trail and the road
  ahead follow real streets (set the hostel and campus locations in `/admin/settings`),
- **pickup requests** the driver accepts or declines,
- one-tap **return-trip announcements** ("Shuttle at KSB → hostel, leaving in 10 min").

Everything (message text, departure times, seats, pickup points, fare, lead times) is set by the
admin inside the app.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 16 (App Router, TypeScript), Tailwind 4, design tokens ported from the Krab mini app |
| Backend | Supabase: Postgres (schema, RLS, SQL functions), Auth (username + PIN mapped to a synthetic email), Realtime (broadcast for GPS), `pg_cron` + `pg_net` as the minute ticker |
| Push | Web Push (VAPID) via `web-push`, hand-written `public/sw.js` |
| Map | Leaflet + CARTO raster tiles (Voyager light / dark_all dark, keyed: `NEXT_PUBLIC_MAP_TILE_URL` + `NEXT_PUBLIC_MAP_TILE_URL_DARK`, the layer follows the colour scheme). Without env it falls back to Esri World Street Map (no key, dark mode = CSS filter on the tile pane). A custom provider's tiles are network-only unless its host is added to `public/sw.js` |
| Tests | Vitest (unit + SQL against a throwaway local Postgres 16), Playwright smoke |

See `docs/` (if present), `supabase/README.md` (database + cron) and `src/lib/push/README.md` (push
delivery) for the deeper notes.

## Roles

- **Student** — `/app`: Today, Live map, Inbox, Me. Books/cancels seats, requests pickups.
- **Driver** — `/driver`: trips with manifests, boarding/departed/arrived, tracking screen, pickup
  requests, return-trip announcements. Admins can use the driver screens too.
- **Admin** — `/admin`: overview + tick health, schedule, pickup points, days off, trips (capacity,
  driver, cancel), users (roles, deactivate, reset PIN), message templates, broadcast, reports,
  settings.

## Local development

```bash
cd shuttle-me
pnpm install
cp .env.example .env.local      # fill in Supabase + VAPID + secrets (see below)
pnpm dev                        # http://localhost:3000
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | the usual |
| `pnpm test` | unit tests (Vitest) |
| `pnpm db:up` / `pnpm db:reset` / `pnpm db:down` | throwaway local Postgres 16 with the migrations applied (no Docker) |
| `pnpm test:sql` | SQL/RLS tests against that local Postgres |
| `pnpm test:e2e` | Playwright smoke tests (starts `next dev` on port 3100) |
| `pnpm vapid` | generate VAPID keys |
| `pnpm seed:admin --username admin --name "Hostel Office" --pin 1234` | create/update the first admin |
| `pnpm icons:build` | rebuild `/public/icons/*.webp` and the app icons from `assets/icon-sources/*.png` |

### Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | client + server | publishable (`sb_publishable_…`) or legacy anon key |
| `SUPABASE_SECRET_KEY` | server only | secret (`sb_secret_…`) or legacy service-role key |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | push | from `pnpm vapid`; subject is `mailto:` |
| `PIN_PEPPER` | server only | random 32+ chars; derives the Supabase password from a user's PIN. Changing it invalidates every PIN. |
| `CRON_SECRET` | server only | bearer token `pg_cron`/cron-job.org must send to `/api/cron/tick` |
| `NEXT_PUBLIC_APP_URL` | client | public URL, used in the install guide and push links |
| `NEXT_PUBLIC_MAP_TILE_URL`, `NEXT_PUBLIC_MAP_TILE_URL_DARK`, `NEXT_PUBLIC_MAP_TILE_ATTRIBUTION`, `NEXT_PUBLIC_MAP_TILE_MAX_NATIVE_ZOOM` | client, optional | basemap templates (production: CARTO Voyager / dark_all with the hostel key, `{r}` = retina), attribution and the provider's deepest zoom (default 18 on cartocdn.com, else 19). Default Esri World Street Map; see `src/lib/map/tiles.ts` |
| `ROUTER_BASE_URL` | server only, optional | OSRM-compatible router for the live map's road route and road-snapped trail (default `https://router.project-osrm.org`, the rate-limited public demo). Calls are cached, time-boxed and best-effort: the map draws straight lines when the router is unavailable. See `src/components/map/README.md` |
| `NEXT_PUBLIC_BUILD_COMMIT` | set by `next.config.ts` | short `VERCEL_GIT_COMMIT_SHA` (or `dev`) baked into the bundle; `BuildRefresh` compares it with `/api/health` on every return to the foreground and reloads a stale installed app |

## Deploying

1. **Supabase project**: create one (region close to Ghana, e.g. London), enable the `pg_cron` and
   `pg_net` extensions, apply `supabase/migrations/*.sql` in order (SQL editor, `supabase db push`,
   or the Supabase MCP `apply_migration`). In **Authentication → Providers → Email** turn **off**
   "Confirm email" and in **Authentication → Settings** turn **off** "Allow new users to sign up"
   (the app creates users itself with the service role).
2. **Secrets**: `pnpm vapid`, then generate `PIN_PEPPER` and `CRON_SECRET` (`openssl rand -hex 32`).
3. **Host the app** (Vercel: import the repo with root directory `shuttle-me` and add the env vars,
   or `npx vercel deploy --prod` from this folder after `vercel env add` for each variable).
   Any Node host works; nothing depends on Vercel. Keep `.vercelignore` so local secrets never upload.
   Functions are pinned to `lhr1` (London) via `vercel.json` because the database is in London.
4. **Admin**: `pnpm seed:admin --username <name> --pin <4–6 digits>` with `.env.local` pointing at
   the project. Log in at `/login`, open `/admin/settings`, check the fare, times and pickup points
   (`/admin/schedule`, `/admin/locations`), and promote the driver in `/admin/users`.
5. **Scheduler**: in the Supabase SQL editor run (see `supabase/README.md`):
   ```sql
   select vault.create_secret('https://<your-app>/api/cron/tick', 'tick_url');
   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
   ```
   The `kharis-tick` job created by migration `0009_cron.sql` then runs every minute: it decides
   what to send in SQL (`run_tick`) and wakes the app to deliver the pushes. `/admin` shows the tick
   health. Optional backup: a cron-job.org job that POSTs to `/api/cron/tick` every 5 minutes with
   `Authorization: Bearer <CRON_SECRET>`.
6. **Students**: share the app URL (or `/install`). If you set a hostel join code in
   `/admin/settings`, give it to residents.

## iPhone checklist (what to try on a real phone)

1. Open the URL in Safari → Share → **Add to Home Screen** → open **Shuttle Me** from the Home
   Screen (the installed app has its own login).
2. Register with a username, full name and PIN, then on the welcome screen tap
   **Turn on reminders** and allow notifications; the test notification should arrive.
3. Lock the phone; an admin broadcast from `/admin/broadcast` should still arrive.
4. Book a seat on the next departure; the driver's phone gets "{name} booked" once the manifest
   was sent, and the rider gets the "leaving in 10 min" nudge.
5. Driver: open the trip → **Start sharing location**, keep the screen on while driving (iOS has no
   background GPS for web apps; the screen stays awake via Wake Lock). Students see the bus move on
   **Live**.
6. Student: **Request a pickup** → driver sees it instantly and accepts/declines → student is
   notified.

## How the pieces fit

- `supabase/migrations/` — the whole data model, RLS, booking/waitlist logic, notification outbox,
  and the minute tick (`run_tick`). SQL functions are the single source of truth for state changes;
  route handlers call them via RPC.
- `src/app/api/` — route handlers (zod-validated) for auth (username + PIN), bookings, pickup
  requests, driver actions, GPS points, admin CRUD, push subscriptions and the cron tick.
- `src/lib/push/` — Web Push delivery and the outbox drain (idempotent, retries across ticks).
- `src/components/ui/`, `src/app/globals.css` — the design system (iOS grouped look from the Krab
  mini app: grey ground, white cards, blue pill buttons, gradient hero tiles with glossy 3D icons).
- `public/sw.js` — service worker: push display, notification clicks, subscription rotation; never
  caches HTML.
