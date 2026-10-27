/**
 * One web-push delivery, with the push service's response classified so the
 * outbox drain can decide what to do with the subscription and the row.
 */
import type { ClaimedSubscription } from "@/lib/db.types";
import { serializePayload, type PushPayload } from "./payload";
import { getWebPush } from "./vapid";

export type Urgency = "very-low" | "low" | "normal" | "high";

export type SendOptions = {
  /** Seconds the push service keeps the message if the device is offline. */
  ttl?: number;
  urgency?: Urgency | string | null;
  /** Socket timeout in ms (default 10 s). */
  timeoutMs?: number;
};

export type SendResult =
  | { ok: true; status: number }
  | {
      ok: false;
      /** HTTP status from the push service, or 0 for a network / library error. */
      status: number;
      /** 404 / 410: the subscription no longer exists → caller deletes it. */
      gone: boolean;
      /** 429 / 5xx / network: worth another attempt later. */
      retryable: boolean;
      error: string;
    };

const URGENCIES: ReadonlySet<string> = new Set<Urgency>(["very-low", "low", "normal", "high"]);

export function normalizeUrgency(value: string | null | undefined): Urgency {
  return value && URGENCIES.has(value) ? (value as Urgency) : "normal";
}

type WebPushErrorLike = { statusCode?: number; body?: unknown; message?: string; code?: string; endpoint?: string };

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED"]);

/** Turn an error thrown by web-push into a classified failure. Exported for tests. */
export function classifyFailure(err: unknown, endpoint: string): Extract<SendResult, { ok: false }> {
  const e = (err ?? {}) as WebPushErrorLike;
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;
  const detail = typeof e.body === "string" && e.body.trim() ? e.body.trim().slice(0, 200) : "";
  const message = `${e.message ?? "push failed"}${detail ? ` — ${detail}` : ""}`.slice(0, 300);

  if (status === 404 || status === 410) {
    return { ok: false, status, gone: true, retryable: false, error: `${status} subscription gone` };
  }
  if (status === 401 || status === 403) {
    // VAPID mismatch: the key pair the browser subscribed with is not the one we sign with.
    console.error(
      `[push] ${status} from push service for ${hostOf(endpoint)} — VAPID keys are misconfigured ` +
        `(NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT). ${message}`,
    );
    return { ok: false, status, gone: false, retryable: false, error: `${status} vapid rejected: ${message}` };
  }
  if (status === 429 || status >= 500) {
    return { ok: false, status, gone: false, retryable: true, error: `${status} ${message}` };
  }
  if (status === 413) {
    return { ok: false, status, gone: false, retryable: false, error: `413 payload too large` };
  }
  if (status > 0) {
    // 400, 406 and other client errors: our request is wrong for this endpoint; retrying will not help.
    return { ok: false, status, gone: false, retryable: false, error: `${status} ${message}` };
  }
  const code = typeof e.code === "string" ? e.code : "";
  const networkish =
    NETWORK_CODES.has(code) || /timed? ?out|socket hang up|network|ECONN|EAI_AGAIN|TLS|certificate/i.test(message);
  if (networkish) {
    return { ok: false, status: 0, gone: false, retryable: true, error: `network: ${message}` };
  }
  // Encryption / key-format errors (bad p256dh or auth): permanent for this subscription.
  return { ok: false, status: 0, gone: false, retryable: false, error: `send error: ${message}` };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "push endpoint";
  }
}

/**
 * Deliver one payload to one subscription. Never throws.
 */
export async function sendToSubscription(
  sub: Pick<ClaimedSubscription, "endpoint" | "p256dh" | "auth"> & { id?: string },
  payload: PushPayload | string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const body = typeof payload === "string" ? payload : serializePayload(payload);
  let webpush: ReturnType<typeof getWebPush>;
  try {
    webpush = getWebPush();
  } catch (err) {
    console.error("[push] VAPID is not configured:", err instanceof Error ? err.message : err);
    return { ok: false, status: 0, gone: false, retryable: false, error: "vapid not configured" };
  }
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      {
        TTL: Math.max(0, Math.round(opts.ttl ?? 3600)),
        urgency: normalizeUrgency(opts.urgency),
        timeout: opts.timeoutMs ?? 10_000,
      },
    );
    return { ok: true, status: res.statusCode };
  } catch (err) {
    return classifyFailure(err, sub.endpoint);
  }
}
