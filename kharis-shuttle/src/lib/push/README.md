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
| `payload.ts` | `PushPayload` type, `buildPayload(row)` (same-origin `url`, `tag = collapse_tag ?? kind`), `serializePayload` with the **3 KB guard** (push services reject > 4 KB after encryption). |
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

* **Claim**: `claim_pending_notifications(limit)` takes `pending` rows (and `sending` rows stuck > 2 min from a crashed drain) whose TTL has not passed and `push_attempts < 5`, marks them `sending` and increments `push_attempts`. Concurrent drains are safe (`skip locked`).
* **Fan-out**: one payload per row, sent to every active subscription of the recipient (`disabled_at is null`), at most `concurrency` (20) pushes in flight across the batch.
* **Row outcome**
  * any device accepted → `sent`
  * no active subscription → `skipped` (`no active push subscription`)
  * every subscription gone (404/410) → subscriptions deleted, row `skipped`
  * a retryable failure and no success → `pending` again (next tick retries); after the 5th attempt → `failed`
  * only permanent failures → `failed`
* **Budget**: the drain stops claiming new batches once `budgetMs` has passed; rows claimed but not started by then are handed straight back (`pending`) instead of sitting in `sending` for two minutes. `/api/cron/tick` uses 55 s (`maxDuration = 60`), `after()` drains use 25 s.

## Failure classes (`send.ts`)

| push service says | meaning | what we do |
|---|---|---|
| 201 / 2xx | accepted | `last_success_at = now`, `fail_count = 0` |
| 404 / 410 | subscription no longer exists (user revoked, browser rotated the endpoint, app uninstalled) | **delete** the subscription row (`gone`) |
| 401 / 403 | VAPID rejected — the key pair the device subscribed with is not the one we sign with, or `VAPID_SUBJECT` is bad | not retryable; logged loudly with `[push] … VAPID keys are misconfigured`; `fail_count + 1` |
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

`run_tick()` in SQL runs every minute from `pg_cron` regardless of the web host; `cron_tick()` then calls `POST /api/cron/tick` through `pg_net` so pushes leave right away. Any external cron (cron-job.org, GitHub Actions) can hit the same URL with the bearer as a backup. The response carries the `tick_runs` row and the drain counters; a non-200 means `run_tick` failed.
