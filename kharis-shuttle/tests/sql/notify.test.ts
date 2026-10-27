import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { IDS, errorOf, one, resetDb, rows, scalar } from "./helpers";

let c: Client;

beforeAll(async () => {
  c = await resetDb();
});

afterAll(async () => {
  await c?.end();
});

type Claimed = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown>;
  ttl_seconds: number;
  urgency: string;
  collapse_tag: string | null;
  push_attempts: number;
  subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[];
};

describe("render_template", () => {
  it("fills placeholders, blanks unknown ones and falls back for a missing template", async () => {
    const r = await one<{ title: string; body: string }>(
      c,
      `select * from render_template('trip_nudge', '{"count": 10, "pickup": "Hostel main gate"}'::jsonb)`,
    );
    expect(r.title).toBe("⏰ Leaving in 10 min");
    expect(r.body).toBe("Be at Hostel main gate. Have cash ready."); // {fare} missing → ''

    await c.query("update message_templates set body = 'Hi {name}, {unknown} {message}' where key = 'test'");
    const t = await one<{ title: string; body: string }>(c, `select * from render_template('test', '{"name":"Abena"}'::jsonb)`);
    expect(t.body).toBe("Hi Abena,");
    await c.query(`update message_templates set body = 'You''ll get shuttle reminders here, {name}.' where key = 'test'`);

    await c.query("delete from message_templates where key = 'broadcast'");
    const fb = await one<{ title: string; body: string }>(c, `select * from render_template('broadcast', '{}'::jsonb)`);
    expect(fb.title).toBe("broadcast");
    expect(fb.body).toBe("");
    await c.query(`insert into message_templates (key, title, body) values ('broadcast', '📣 {title}', '{message}')`);
  });

  it("substitutes in a single pass: values containing {placeholders} are not re-expanded", async () => {
    await c.query("update message_templates set title = 'Hi {name}', body = '{name}: {message}' where key = 'test'");
    const r = await one<{ title: string; body: string }>(
      c,
      `select * from render_template('test', '{"name":"{message}", "message":"secret body"}'::jsonb)`,
    );
    expect(r.title).toBe("Hi {message}");
    expect(r.body).toBe("{message}: secret body");
    // a value that names an unknown placeholder, or a lone brace, is literal too
    expect(await scalar<string>(c, `select render_text('{a} {b}', '{"a":"{b}","b":"{a}"}')`)).toBe("{b} {a}");
    expect(await scalar<string>(c, `select render_text('open { brace {x}', '{"x":"1"}')`)).toBe("open { brace 1");
    await c.query(`update message_templates set title = '🔔 Notifications are on', body = 'You''ll get shuttle reminders here, {name}.' where key = 'test'`);
  });

  it("collapses runs of spaces/tabs but keeps newlines", async () => {
    await c.query(`update message_templates set body = E'Hi {name},\nyour seat   is {seat}.\t\tSee you.' where key = 'test'`);
    const r = await one<{ title: string; body: string }>(c, `select * from render_template('test', '{"name":"Abena","seat":"A1"}'::jsonb)`);
    expect(r.body).toBe("Hi Abena,\nyour seat is A1. See you.");
    expect(r.body.split("\n")).toHaveLength(2);
    // empty placeholder at a line start/end does not swallow the newline
    expect(await scalar<string>(c, `select render_text(E'{x}\nline two', '{}')`)).toBe("line two");
    expect(await scalar<string>(c, `select render_text(E'line one {x}\nline two', '{}')`)).toBe("line one \nline two");
    await c.query(`update message_templates set body = 'You''ll get shuttle reminders here, {name}.' where key = 'test'`);
  });

  it("format_fare mirrors the app helper", async () => {
    expect(await scalar<string>(c, "select format_fare(1000)")).toBe("GH₵10");
    expect(await scalar<string>(c, "select format_fare(1250)")).toBe("GH₵12.50");
    expect(await scalar<string>(c, "select format_fare(500, 'NGN')")).toBe("NGN 5");
  });
});

describe("enqueue_notification", () => {
  it("inserts one row per active recipient, deduplicated by prefix:user", async () => {
    const n = await scalar<number>(
      c,
      `select enqueue_notification(array[$1, $2, $2, $3]::uuid[], 'broadcast', '{"title":"Hello","message":"Water is off today"}', '/app/inbox', 'bc:1', 600, 'low', 'bc')`,
      [IDS.s1, IDS.s2, IDS.s3],
    );
    expect(n).toBe(3);
    const again = await scalar<number>(
      c,
      `select enqueue_notification(array[$1, $2]::uuid[], 'broadcast', '{"title":"Hello","message":"x"}', null, 'bc:1')`,
      [IDS.s1, IDS.s2],
    );
    expect(again).toBe(0);
    const row = await one<{ title: string; body: string; url: string; ttl_seconds: number; urgency: string; collapse_tag: string; dedupe_key: string; push_status: string }>(
      c,
      "select title, body, url, ttl_seconds, urgency, collapse_tag, dedupe_key, push_status from notifications where user_id = $1",
      [IDS.s1],
    );
    expect(row).toEqual({
      title: "📣 Hello",
      body: "Water is off today",
      url: "/app/inbox",
      ttl_seconds: 600,
      urgency: "low",
      collapse_tag: "bc",
      dedupe_key: `bc:1:${IDS.s1}`,
      push_status: "pending",
    });
  });

  it("treats a null or unknown urgency as 'normal'", async () => {
    expect(
      await scalar<number>(c, `select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'urg:null', 600, null, null)`, [IDS.s1]),
    ).toBe(1);
    expect(await scalar<string>(c, "select urgency from notifications where dedupe_key = $1", [`urg:null:${IDS.s1}`])).toBe("normal");
    expect(
      await scalar<number>(c, `select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'urg:bogus', 600, 'urgent!!', null)`, [IDS.s1]),
    ).toBe(1);
    expect(await scalar<string>(c, "select urgency from notifications where dedupe_key = $1", [`urg:bogus:${IDS.s1}`])).toBe("normal");
    expect(
      await scalar<number>(c, `select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'urg:high', 600, 'high', null)`, [IDS.s1]),
    ).toBe(1);
    expect(await scalar<string>(c, "select urgency from notifications where dedupe_key = $1", [`urg:high:${IDS.s1}`])).toBe("high");
  });

  it("skips inactive profiles and empty recipient lists", async () => {
    await c.query("update profiles set is_active = false where id = $1", [IDS.s3]);
    expect(await scalar<number>(c, `select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'inactive:1')`, [IDS.s3])).toBe(0);
    await c.query("update profiles set is_active = true where id = $1", [IDS.s3]);
    expect(await scalar<number>(c, `select enqueue_notification(array[]::uuid[], 'test', '{}', null, 'empty:1')`)).toBe(0);
    expect(await scalar<number>(c, `select enqueue_notification(null, 'test', '{}', null, 'empty:2')`)).toBe(0);
  });
});

describe("claim_pending_notifications / finish_notification", () => {
  it("claims pending rows, attaches active subscriptions and marks them sending", async () => {
    await c.query("delete from notifications");
    await c.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, platform) values
         ($1, 'https://push.example/a', 'p256-a', 'auth-a', 'ios'),
         ($1, 'https://push.example/a2', 'p256-a2', 'auth-a2', 'ios'),
         ($2, 'https://push.example/b', 'p256-b', 'auth-b', 'android')`,
      [IDS.s1, IDS.s2],
    );
    await c.query("update push_subscriptions set disabled_at = now() where endpoint = 'https://push.example/b'");
    await c.query(`select enqueue_notification(array[$1, $2, $3]::uuid[], 'test', '{"name":"you"}', '/welcome', 'test:1')`, [
      IDS.s1,
      IDS.s2,
      IDS.s3,
    ]);

    const claimed = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(claimed).toHaveLength(3);
    expect(claimed.every((r) => r.push_attempts === 1)).toBe(true);
    const byUser = Object.fromEntries(claimed.map((r) => [r.user_id, r]));
    expect(byUser[IDS.s1]?.subscriptions.map((s) => s.endpoint).sort()).toEqual(["https://push.example/a", "https://push.example/a2"]);
    expect(byUser[IDS.s1]?.subscriptions[0]).toMatchObject({ p256dh: expect.any(String), auth: expect.any(String), id: expect.any(String) });
    expect(byUser[IDS.s2]?.subscriptions).toEqual([]); // disabled subscription excluded
    expect(byUser[IDS.s3]?.subscriptions).toEqual([]);
    expect(byUser[IDS.s1]?.title).toBe("🔔 Notifications are on");
    expect(byUser[IDS.s1]?.body).toBe("You'll get shuttle reminders here, you.");

    const states = await rows<{ push_status: string; push_attempts: number; push_claimed_at: Date | null }>(
      c,
      "select push_status, push_attempts, push_claimed_at from notifications",
    );
    expect(states.every((s) => s.push_status === "sending" && s.push_attempts === 1 && s.push_claimed_at)).toBe(true);

    // nothing left to claim right now
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);

    // finish: sent / skipped / failed→pending retry
    const s1 = byUser[IDS.s1]!;
    const s2 = byUser[IDS.s2]!;
    const s3 = byUser[IDS.s3]!;
    await c.query("select finish_notification($1, 'sent')", [s1.id]);
    await c.query("select finish_notification($1, 'skipped', 'no subscriptions')", [s2.id]);
    await c.query("select finish_notification($1, 'pending', '429 retry')", [s3.id]);
    const after = await rows<{ id: string; push_status: string; push_sent_at: Date | null; push_error: string | null }>(
      c,
      "select id, push_status, push_sent_at, push_error from notifications",
    );
    const m = Object.fromEntries(after.map((r) => [r.id, r]));
    expect(m[s1.id]).toMatchObject({ push_status: "sent", push_error: null });
    expect(m[s1.id]?.push_sent_at).toBeTruthy();
    expect(m[s2.id]).toMatchObject({ push_status: "skipped", push_error: "no subscriptions" });
    expect(m[s3.id]).toMatchObject({ push_status: "pending", push_error: "429 retry" });

    // handing a row back keeps push_claimed_at, so the SAME drain run cannot re-claim it …
    expect(await scalar<Date | null>(c, "select push_claimed_at from notifications where id = $1", [s3.id])).toBeTruthy();
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);
    expect(await scalar<number>(c, "select push_attempts from notifications where id = $1", [s3.id])).toBe(1);

    // … but after 45 s it is claimable again, with attempts = 2
    await c.query("update notifications set push_claimed_at = now() - interval '46 seconds' where id = $1", [s3.id]);
    const second = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(second.map((r) => r.id)).toEqual([s3.id]);
    expect(second[0]?.push_attempts).toBe(2);
    expect(await scalar<number>(c, "select push_attempts from notifications where id = $1", [s3.id])).toBe(2);
  });

  it("a 'pending' row handed back inside the 45 s window waits; a never-claimed row does not", async () => {
    await c.query("delete from notifications");
    await c.query(`select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'retry:1')`, [IDS.s1]);
    const first = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(first).toHaveLength(1);
    await c.query("select finish_notification($1, 'pending', '503 retry')", [first[0]!.id]);
    // 44 s later: still held back
    await c.query("update notifications set push_claimed_at = now() - interval '44 seconds'");
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);
    // a fresh row (push_claimed_at null) is served straight away, the held one is not
    await c.query(`select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'retry:2')`, [IDS.s2]);
    const fresh = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(fresh.map((r) => r.user_id)).toEqual([IDS.s2]);
    // 46 s later: served
    await c.query("update notifications set push_claimed_at = now() - interval '46 seconds' where user_id = $1", [IDS.s1]);
    const retried = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(retried.map((r) => r.user_id)).toEqual([IDS.s1]);
    expect(retried[0]?.push_attempts).toBe(2);
    // run_tick's hygiene never touches a 'pending' row inside its TTL.
    // run_tick(now()) may also enqueue rows of its own (the daily announcement between
    // 06:00 and 08:00 local, reminders, manifests), so every read below is by id.
    const retriedId = retried[0]!.id;
    await c.query("select finish_notification($1, 'pending', '503 again')", [retriedId]);
    await c.query("select run_tick(now())");
    expect(await scalar<string>(c, "select push_status from notifications where id = $1", [retriedId])).toBe("pending");
  });

  it("re-claims rows stuck in sending for more than 2 minutes and gives up after 5 attempts", async () => {
    await c.query("delete from notifications");
    await c.query(`select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'stuck:1')`, [IDS.s1]);
    const stuckId = await scalar<string>(c, "select id from notifications where dedupe_key = $1", [`stuck:1:${IDS.s1}`]);
    await c.query("update notifications set push_status = 'sending', push_claimed_at = now() - interval '3 minutes', push_attempts = 1 where id = $1", [stuckId]);
    const claimed = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(claimed.map((r) => r.id)).toEqual([stuckId]);
    expect(await scalar<number>(c, "select push_attempts from notifications where id = $1", [stuckId])).toBe(2);

    await c.query("update notifications set push_status = 'sending', push_claimed_at = now() - interval '3 minutes', push_attempts = 5 where id = $1", [stuckId]);
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);
    // run_tick's hygiene marks it failed (read by id: the tick may enqueue rows of its own)
    await c.query("select run_tick(now())");
    expect(await scalar<string>(c, "select push_status from notifications where id = $1", [stuckId])).toBe("failed");
  });

  it("skips rows whose TTL already expired", async () => {
    await c.query("delete from notifications");
    await c.query(`select enqueue_notification(array[$1]::uuid[], 'trip_nudge', '{}', null, 'ttl:1', 60)`, [IDS.s1]);
    const ttlId = await scalar<string>(c, "select id from notifications where dedupe_key = $1", [`ttl:1:${IDS.s1}`]);
    await c.query("update notifications set created_at = now() - interval '5 minutes' where id = $1", [ttlId]);
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);
    await c.query("select run_tick(now())");
    expect(await scalar<string>(c, "select push_status from notifications where id = $1", [ttlId])).toBe("skipped");
  });
});

describe("function privileges", () => {
  it("service-only functions are not executable by authenticated", async () => {
    await c.query("begin");
    await c.query("set local role authenticated");
    expect(await errorOf(c, "select run_tick()")).toMatch(/permission denied/);
    expect(await errorOf(c, "select claim_pending_notifications(1)")).toMatch(/permission denied/);
    expect(await errorOf(c, "select book_seat($1, $2)", [IDS.s1, IDS.s1])).toMatch(/permission denied/);
    expect(await errorOf(c, "select enqueue_notification(array[]::uuid[], 'test', '{}', null, 'x')")).toMatch(/permission denied/);
    expect(await errorOf(c, "select materialize_trips(current_date, current_date)")).toMatch(/permission denied/);
    await c.query("rollback");
  });
});

describe("pickup_request_cancelled (migrations 0012 + 0013)", () => {
  it("every notification_kind value has a message template (20 kinds)", async () => {
    const missing = await rows<{ kind: string }>(
      c,
      `select e::text as kind
         from unnest(enum_range(null::public.notification_kind)) as e
         left join message_templates t on t.key = e
        where t.key is null`,
    );
    expect(missing).toEqual([]);
    expect(await scalar<string>(c, "select count(*) from unnest(enum_range(null::public.notification_kind))")).toBe("20");
    expect(await scalar<string>(c, "select count(*) from message_templates")).toBe("20");
  });

  it("renders the template with {name} and {pickup}", async () => {
    const r = await one<{ title: string; body: string }>(
      c,
      `select * from render_template('pickup_request_cancelled', '{"name": "Abena Owusu", "pickup": "KSB"}'::jsonb)`,
    );
    expect(r.title).toBe("🙅 Pickup request withdrawn");
    expect(r.body).toBe("Abena Owusu no longer needs a pickup at KSB.");
  });

  it("enqueue_notification accepts the new kind and dedupes on the route's prefix", async () => {
    await c.query("delete from notifications");
    const enqueue = () =>
      scalar<number>(
        c,
        `select enqueue_notification(array[$1]::uuid[], 'pickup_request_cancelled',
                 '{"name": "Abena Owusu", "pickup": "KSB", "request_id": "req-1"}'::jsonb,
                 '/driver/requests', 'pickup_request_cancelled:req-1', 900, 'high', 'pr:req-1')`,
        [IDS.driver],
      );
    expect(await enqueue()).toBe(1);
    const n = await one<Claimed & { dedupe_key: string }>(
      c,
      "select user_id, kind, title, body, url, dedupe_key, urgency, collapse_tag from notifications where kind = 'pickup_request_cancelled'",
    );
    expect(n).toMatchObject({
      user_id: IDS.driver,
      kind: "pickup_request_cancelled",
      title: "🙅 Pickup request withdrawn",
      body: "Abena Owusu no longer needs a pickup at KSB.",
      url: "/driver/requests",
      dedupe_key: `pickup_request_cancelled:req-1:${IDS.driver}`,
      urgency: "high",
      collapse_tag: "pr:req-1",
    });
    expect(await enqueue()).toBe(0); // a retry of the same withdrawal never pushes twice
    const claimed = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(claimed.map((x) => x.kind)).toEqual(["pickup_request_cancelled"]);
  });
});
