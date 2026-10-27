import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendNotification, setVapidDetails } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: { sendNotification, setVapidDetails, generateVAPIDKeys: vi.fn() },
}));

import { classifyFailure, normalizeUrgency, sendToSubscription } from "@/lib/push/send";
import { resetWebPushForTests } from "@/lib/push/vapid";

class FakeWebPushError extends Error {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  endpoint: string;
  constructor(statusCode: number, body = "") {
    super(`Received unexpected response code`);
    this.name = "WebPushError";
    this.statusCode = statusCode;
    this.body = body;
    this.headers = {};
    this.endpoint = "https://push.example/abc";
  }
}

const sub = { id: "s1", endpoint: "https://web.push.apple.com/QW1hemlu", p256dh: "BPUBLICKEY", auth: "AUTH" };
const payload = { title: "Hi", body: "there", url: "/app", kind: "test", id: "n1" };

describe("sendToSubscription", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "BPUBLIC");
    vi.stubEnv("VAPID_PRIVATE_KEY", "PRIVATE");
    vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.com");
    vi.stubEnv("PIN_PEPPER", "a-very-long-pepper-value-for-tests");
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
    resetWebPushForTests();
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
  });

  it("201 → ok, configures VAPID once and passes TTL + urgency", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    const r1 = await sendToSubscription(sub, payload, { ttl: 900, urgency: "high" });
    const r2 = await sendToSubscription(sub, JSON.stringify(payload));
    expect(r1).toEqual({ ok: true, status: 201 });
    expect(r2.ok).toBe(true);
    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:test@example.com", "BPUBLIC", "PRIVATE");
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [subscription, body, options] = sendNotification.mock.calls[0]!;
    expect(subscription).toEqual({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    expect(JSON.parse(body as string)).toEqual(payload);
    expect(options).toMatchObject({ TTL: 900, urgency: "high", timeout: 10_000 });
    expect(sendNotification.mock.calls[1]![2]).toMatchObject({ TTL: 3600, urgency: "normal" });
  });

  it("410 → gone, not retryable", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(410, "unsubscribed"));
    const r = await sendToSubscription(sub, payload);
    expect(r).toMatchObject({ ok: false, status: 410, gone: true, retryable: false });
  });

  it("404 → gone too", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(404));
    expect(await sendToSubscription(sub, payload)).toMatchObject({ ok: false, status: 404, gone: true });
  });

  it("429 → retryable, not gone", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(429, "slow down"));
    const r = await sendToSubscription(sub, payload);
    expect(r).toMatchObject({ ok: false, status: 429, gone: false, retryable: true });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("503 → retryable", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(503));
    expect(await sendToSubscription(sub, payload)).toMatchObject({ ok: false, status: 503, retryable: true, gone: false });
  });

  it("403 → not retryable, not gone, logged loudly as a VAPID problem", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(403, "VAPID credentials mismatch"));
    const r = await sendToSubscription(sub, payload);
    expect(r).toMatchObject({ ok: false, status: 403, gone: false, retryable: false });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toMatch(/VAPID/);
  });

  it("401 → same class as 403", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(401));
    expect(await sendToSubscription(sub, payload)).toMatchObject({ ok: false, status: 401, gone: false, retryable: false });
  });

  it("network errors are retryable", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    expect(await sendToSubscription(sub, payload)).toMatchObject({ ok: false, status: 0, gone: false, retryable: true });
  });

  it("encryption / key errors are permanent for that subscription", async () => {
    sendNotification.mockRejectedValue(new Error("Public key should be 65 bytes long when decoded."));
    expect(await sendToSubscription(sub, payload)).toMatchObject({ ok: false, status: 0, gone: false, retryable: false });
  });

  it("never throws when VAPID env is missing", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    resetWebPushForTests();
    const r = await sendToSubscription(sub, payload);
    expect(r).toMatchObject({ ok: false, retryable: false, gone: false });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("classifyFailure / normalizeUrgency", () => {
  it("classifies other 4xx as permanent", () => {
    expect(classifyFailure({ statusCode: 400, message: "bad" }, "https://p/x")).toMatchObject({ status: 400, retryable: false, gone: false });
    expect(classifyFailure({ statusCode: 413, message: "big" }, "https://p/x")).toMatchObject({ status: 413, retryable: false });
  });
  it("normalises urgency", () => {
    expect(normalizeUrgency("high")).toBe("high");
    expect(normalizeUrgency("very-low")).toBe("very-low");
    expect(normalizeUrgency("urgent")).toBe("normal");
    expect(normalizeUrgency(null)).toBe("normal");
  });
});
