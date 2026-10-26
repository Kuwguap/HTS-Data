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

    // the retried row is claimable again, with attempts = 2
    const second = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(second.map((r) => r.id)).toEqual([s3.id]);
    expect(await scalar<number>(c, "select push_attempts from notifications where id = $1", [s3.id])).toBe(2);
  });

  it("re-claims rows stuck in sending for more than 2 minutes and gives up after 5 attempts", async () => {
    await c.query("delete from notifications");
    await c.query(`select enqueue_notification(array[$1]::uuid[], 'test', '{}', null, 'stuck:1')`, [IDS.s1]);
    await c.query("update notifications set push_status = 'sending', push_claimed_at = now() - interval '3 minutes', push_attempts = 1");
    const claimed = await rows<Claimed>(c, "select * from claim_pending_notifications(10)");
    expect(claimed).toHaveLength(1);
    expect(await scalar<number>(c, "select push_attempts from notifications")).toBe(2);

    await c.query("update notifications set push_status = 'sending', push_claimed_at = now() - interval '3 minutes', push_attempts = 5");
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);
    // run_tick's hygiene marks it failed
    await c.query("select run_tick(now())");
    expect(await scalar<string>(c, "select push_status from notifications")).toBe("failed");
  });

  it("skips rows whose TTL already expired", async () => {
    await c.query("delete from notifications");
    await c.query(`select enqueue_notification(array[$1]::uuid[], 'trip_nudge', '{}', null, 'ttl:1', 60)`, [IDS.s1]);
    await c.query("update notifications set created_at = now() - interval '5 minutes'");
    expect(await rows(c, "select * from claim_pending_notifications(10)")).toHaveLength(0);
    await c.query("select run_tick(now())");
    expect(await scalar<string>(c, "select push_status from notifications")).toBe("skipped");
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
