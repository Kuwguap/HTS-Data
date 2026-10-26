# Push delivery

How a notification gets from "something happened" to a banner on a student's lock screen.

```
app event / run_tick ──► enqueue_notification() ──► notifications (inbox + outbox, push_status = pending)
                                                            │
                     POST /api/cron/tick  ─┐                │ claim_pending_notifications(limit)
                     after() in handlers  ─┴─► drainOutbox() ◄┘   (for update skip locked, attempts + 1)
                                                            │
                                   sendToSubscription() per active push_subscriptions row (web-push, VAPID)
                                                            │
                                            finish_notification(id, sent | skipped | failed | pending)
```

## Files

| file | role |
|---|---|
| `vapid.ts` | `getWebPush()` — the `web-push` module with `setVapidDetails` applied once per process. |
| `payload.ts` | `PushPayload` type, `buildPayload(row)` (same-origin `url`, `tag = collapse_tag ?? kind`, title defaults to `APP_NAME`), `serializePayload` with the **3 KB guard** (push services reject > 4 KB after encryption). Shrink order: title/tag capped (200 / 100 escaped bytes) → body cut to the room left → media dropped → url/tag fallback → title; the body is re-fitted from the original after each step so a huge title or icon can never wipe it. |
| `send.ts` | `sendToSubscription(sub, payload, {ttl, urgency})` → `{ok:true}` or `{ok:false, status, gone, retryable}`. Never throws. |
| `drain.ts` | `drainOutbox({limit, budgetMs, concurrency, admin})` — the loop. `pLimit()` is the in-house concurrency limiter. |
| `../notify/enqueue.ts` | `enqueueNotification`, `listActiveStudentIds`, `listDriverIds`, `notifyAndDrain` (enqueue + `after(() => drainOutbox())`). |
| `sw-logic.ts` | Pure functions mirrored into `public/sw.js` (parse payload → `showNotification`, click → URL). |

## Environment

| var | where | notes |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | browser + server | `pushManager.subscribe({applicationServerKey})` and the VAPID JWT. |
| `VAPID_PRIVATE_KEY` | server | Signs the VAPID JWT. Never `NEXT_PUBLIC`. |
| `VAPID_SUBJECT` | server | `mailto:` or `https:` contact the push service may use. |
| `CRON_SECRET` | server + pg_cron (Vault) | `Authorization: Bearer <CRON_SECRET>` on `/api/cron/tick`. |

Generate the key pair once with `pnpm vapid` and keep it: rotating the keys invalidates every subscription (every device has to re-enable reminders).

## Delivery rules

* **Claim**: `claim_pending_notifications(limit)` takes `pending` rows that were never claimed or whose last claim is > 45 s old (and `sending` rows stuck > 2 min from a crashed drain) whose TTL has not passed and `push_attempts < 5`, marks them `sending`, increments `push_attempts` and returns the incremented value. Concurrent drains are safe (`skip locked`).
* **Fan-out**: one payload per row, sent to every active subscription of the recipient (`disabled_at is null`), at most `concurrency` (20) pushes in flight across the batch.
* **Row outcome**
  * any device accepted → `sent`
  * no active subscription → `skipped` (`no active push subscription`)
  * every subscription gone (404/410) → subscriptions deleted, row `skipped`
  * a retryable failure and no success → `pending` again (next tick retries); after the 5th attempt → `failed`
  * only permanent failures → `failed`
  * 401/403 from the push service (our VAPID keys) on **every** live device → **handed back** (see below): the row stays `pending` and delivers once the keys are fixed. When the results are mixed (one device 403, another 429 or 400) the row is an ordinary attempt — retried or failed by `push_attempts` like any other — and only the devices with a real device-side failure get their `fail_count` bumped; the 403 ones are left alone.
* **Hand-back (attempt refund)**: a row the drain claimed but never tried to send — the budget ran out, the claim re-served an id this run already handled, or every device rejected our VAPID keys — is put back with `update notifications set push_status = 'pending', push_attempts = push_attempts - 1` (never below 0) so an unsent row never loses one of its 5 attempts. `finish_notification(…, 'pending')` keeps `push_claimed_at`, so the row is invisible to the claim for 45 s: the run that handed it back cannot take it again; the next tick does. A VAPID hand-back writes `push_error = 'vapid-misconfig x<n> (…)'` and the counter is bounded: the 31st (`MAX_VAPID_HANDBACKS = 30`) marks the row `failed` instead, so a misconfigured deployment does not retry the same rows every minute for days. A re-served row is handed back **without** touching `push_error` (the useful error from its real attempt stays).
* **One run never re-sends a row**: `drainOutbox` remembers the ids it claimed. A later batch that re-serves one (a `pending` hand-back with the cooldown already over, or a fake clock in tests) is handed back untouched and counted in `reserved` (not in `claimed` / `requeued` / `rows`), and a batch made only of such ids ends the loop. Without this a single run could retry a 429 row five times within a second and burn every attempt.
* **Budget**: the drain stops claiming new batches once `budgetMs` has passed; rows claimed but not started by then are handed back (attempt refunded) instead of sitting in `sending` for two minutes. A budget of 0 (or less) returns at once without claiming anything — claiming would only hide the rows behind the 45 s cooldown. `/api/cron/tick` computes the budget from what is left of `maxDuration = 60` after `run_tick`, minus the 10 s push socket timeout and 2 s safety (48 s at most), and skips the drain altogether when nothing is left (`push: null`, `push_skipped_reason` set); `after()` drains use 25 s.
* **Subscription counters**: `fail_count` is a read-modify-write from Node. Within one run every read/write for a given subscription id is serialised (a per-id promise chain with the last value cached), so several rows for the same person in one batch cannot lose increments. Two drains running at once can still race on the same subscription; that is accepted for now (worst case a disable happens a push later). The SQL-side fix, if it ever matters: a `bump_subscription_failures(uuid[])` function doing `update push_subscriptions set fail_count = fail_count + 1, disabled_at = case when fail_count + 1 >= 10 then now() end where id = any($1)` in one statement.

## Failure classes (`send.ts`)

| push service says | meaning | what we do |
|---|---|---|
| 201 / 2xx | accepted | `last_success_at = now`, `fail_count = 0` |
| 404 / 410 | subscription no longer exists (user revoked, browser rotated the endpoint, app uninstalled) | **delete** the subscription row (`gone`) |
| 401 / 403 | VAPID rejected — the key pair the device subscribed with is not the one we sign with, or `VAPID_SUBJECT` is bad | our problem, not the device's: logged loudly with `[push] … VAPID keys are misconfigured`; `fail_count` **untouched**, nothing disabled; when every live device says so the row is handed back `pending` with its attempt refunded (at most 30 times) so it goes out once the keys are fixed (until its TTL passes). A missing key pair (`vapid not configured`) is treated the same way |
| 429 / 5xx | push service busy or down | retryable; `fail_count + 1`; the row goes back to `pending` |
| 413 / other 4xx | our request is wrong for that endpoint | not retryable; `fail_count + 1` |
| network error / timeout (10 s socket timeout) | could not reach the service | retryable |
| encryption error (bad `p256dh` / `auth`) | the stored keys are corrupt | not retryable; `fail_count + 1` |

A subscription whose `fail_count` reaches 10 gets `disabled_at = now` and is no longer claimed; re-subscribing from the device (`POST /api/push/subscribe`, upsert on `endpoint`) resets both fields.

## iOS notes

* Web Push on iPhone only works inside the installed (home-screen) PWA after `Notification.requestPermission()` from a tap. The `/welcome` flow handles that and calls `POST /api/push/test` which enqueues a `test` notification and drains **inline**, so the UI can say "sent to N devices".
* iOS shows no notification action buttons — every push opens `payload.url` (same-origin path only; anything else falls back to `/app`).
* `tag` collapses repeated notifications (e.g. `trip:<id>`), so a reminder followed by a nudge for the same trip does not pile up.

## Scheduling

`run_tick()` in SQL runs every minute from `pg_cron` regardless of the web host; `cron_tick()` then calls `POST /api/cron/tick` through `pg_net` with the body `{"source":"pg_cron","at":…}` so pushes leave right away. Because the tick already ran in SQL, the route **skips `rpc('run_tick')` when the JSON body says `source: "pg_cron"`** and only drains (`tick_ran: false` in the response). Any external cron (cron-job.org, GitHub Actions) can hit the same URL with the bearer as a backup — a GET, an empty body or any other `source` runs the tick as well. The response carries the `tick_runs` row (when it ran) and the drain counters; a non-200 means `run_tick` failed.
