"use client";

import { useCallback, useEffect, useState } from "react";
import { publicEnv } from "@/lib/env";
import { deleteSubscription, postSubscription, serviceWorkerEnabled, urlBase64ToUint8Array } from "@/lib/push/client";
import { notifyPermissionChanged, useStandalone } from "./useStandalone";

export type PushStatus = "unsupported" | "needs-install" | "denied" | "off" | "on" | "working";

/**
 * Outcome of subscribe / unsubscribe / sendTest. `error` is sentence case, no emoji, for a toast.
 * `delivered` is only set by sendTest: how many devices accepted the test push.
 */
export type PushResult = { ok: boolean; error: string | null; delivered?: number };

/** The parts of the POST /api/push/test body the hook reads. */
type PushTestResponse = { sent?: boolean; delivered?: number; devices?: number; pruned?: number };

export type PushSubscriptionState = {
  status: PushStatus;
  /** Human-readable reason for the last failure (sentence case, no emoji). Mirrors the last PushResult.error. */
  error: string | null;
  /** Current endpoint when subscribed. */
  endpoint: string | null;
  /** Must be called from a user gesture (tap). Resolves { ok: true } when subscribed and saved. */
  subscribe: () => Promise<PushResult>;
  unsubscribe: () => Promise<PushResult>;
  /** POST /api/push/test → the server sends "Notifications are on" to this user. */
  sendTest: () => Promise<PushResult>;
};

const fail = (error: string): PushResult => ({ ok: false, error });
const OK: PushResult = { ok: true, error: null };

async function getRegistration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  // Providers registers /sw.js on mount; wait briefly for it, else register here.
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs));
  const reg = await Promise.race([ready, timeout]);
  if (reg) return reg;
  // Same gate as ServiceWorkerRegistrar: never register the worker in dev.
  if (!serviceWorkerEnabled()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  } catch {
    return null;
  }
}

/**
 * Web Push subscription lifecycle for the signed-in user.
 *
 * - Status is derived from platform facts + Notification.permission + whether a
 *   PushSubscription exists.
 * - On mount, an existing subscription is re-POSTed (idempotent upsert) so
 *   rotated endpoints land in the database. The effect is StrictMode-safe: a
 *   cancelled run is simply re-run by the next mount (the POST is idempotent).
 * - `subscribe()` must run inside a tap handler (iOS requirement).
 * - Every action resolves to `{ ok, error }`; use that (not the `error` state,
 *   which is updated asynchronously) right after awaiting.
 */
export function usePushSubscription(): PushSubscriptionState {
  const env = useStandalone();
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  // Resync on mount: read the current subscription, re-POST it once per mount.
  useEffect(() => {
    if (!env.ready || !env.pushCapable) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = (await reg?.pushManager.getSubscription()) ?? null;
        if (cancelled) return;
        setEndpoint(sub?.endpoint ?? null);
        setChecked(true);
        if (sub && Notification.permission === "granted") {
          // Signed-out pages get a 401 here; that is fine.
          await postSubscription(sub).catch(() => 0);
        }
      } catch {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [env.ready, env.pushCapable]);

  const finish = useCallback((result: PushResult): PushResult => {
    setError(result.error);
    return result;
  }, []);

  const subscribe = useCallback(async (): Promise<PushResult> => {
    setError(null);
    if (!env.pushCapable) return finish(fail("Notifications are not supported here."));
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      notifyPermissionChanged();
      if (permission !== "granted") {
        return finish(fail(permission === "denied" ? "Notifications are blocked for this app." : "Permission was not granted."));
      }
      const reg = await getRegistration();
      if (!reg) return finish(fail("The app is not fully installed yet. Reload and try again."));
      const key = publicEnv.vapidPublicKey;
      if (!key) return finish(fail("Push is not configured on the server."));
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      }
      const status = await postSubscription(sub);
      if (status === 401) return finish(fail("Please log in first."));
      if (status >= 400) return finish(fail("Could not save your subscription. Try again."));
      setEndpoint(sub.endpoint);
      return finish(OK);
    } catch (err) {
      return finish(
        fail(err instanceof Error && err.name === "NotAllowedError" ? "Notifications are blocked for this app." : "Could not turn on reminders. Try again."),
      );
    } finally {
      setBusy(false);
      setChecked(true);
    }
  }, [env.pushCapable, finish]);

  const unsubscribe = useCallback(async (): Promise<PushResult> => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // Browser first: if this fails the device still holds a live subscription,
        // so the server row must stay (status remains "on").
        const gone = await sub.unsubscribe().catch(() => false);
        if (!gone) return finish(fail("Could not turn off reminders. Try again."));
        await deleteSubscription(sub.endpoint).catch(() => 0);
      }
      setEndpoint(null);
      return finish(OK);
    } catch {
      return finish(fail("Could not turn off reminders. Try again."));
    } finally {
      setBusy(false);
    }
  }, [finish]);

  const sendTest = useCallback(async (): Promise<PushResult> => {
    let res: Response;
    try {
      res = await fetch("/api/push/test", { method: "POST", credentials: "include" });
    } catch {
      return finish(fail("Could not send a test. Check your connection."));
    }
    if (!res.ok) {
      if (res.status === 401) return finish(fail("Please log in first."));
      return finish(fail("Could not send a test. Try again."));
    }
    // 200 only means the request ran: the body says whether any device got it.
    let body: PushTestResponse = {};
    try {
      body = ((await res.json()) ?? {}) as PushTestResponse;
    } catch {
      body = {};
    }
    const delivered = typeof body.delivered === "number" ? body.delivered : 0;
    const devices = typeof body.devices === "number" ? body.devices : 0;
    const pruned = typeof body.pruned === "number" ? body.pruned : 0;
    if (body.sent !== true || delivered <= 0) {
      if (devices === 0 && pruned > 0) return finish(fail("Your old subscription expired — turn on reminders again."));
      if (devices === 0) return finish(fail("No device is subscribed yet — turn on reminders first."));
      return finish(fail("Could not deliver the test. Try again in a moment."));
    }
    return finish({ ok: true, error: null, delivered });
  }, [finish]);

  let status: PushStatus;
  if (!env.ready) status = "off";
  else if (env.isIOS && !env.isStandalone) status = "needs-install";
  else if (!env.pushCapable) status = "unsupported";
  else if (env.permission === "denied") status = "denied";
  else if (busy || !checked) status = busy ? "working" : "off";
  else if (endpoint && env.permission === "granted") status = "on";
  else status = "off";

  return { status, error, endpoint, subscribe, unsubscribe, sendTest };
}
