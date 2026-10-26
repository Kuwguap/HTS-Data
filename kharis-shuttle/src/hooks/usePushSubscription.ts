"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { publicEnv } from "@/lib/env";
import { deleteSubscription, postSubscription, urlBase64ToUint8Array } from "@/lib/push/client";
import { notifyPermissionChanged, useStandalone } from "./useStandalone";

export type PushStatus = "unsupported" | "needs-install" | "denied" | "off" | "on" | "working";

export type PushSubscriptionState = {
  status: PushStatus;
  /** Human-readable reason for the last failure (sentence case, no emoji). */
  error: string | null;
  /** Current endpoint when subscribed. */
  endpoint: string | null;
  /** Must be called from a user gesture (tap). Resolves true when subscribed and saved. */
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
  /** POST /api/push/test → the server sends "Notifications are on" to this user. */
  sendTest: () => Promise<boolean>;
};

async function getRegistration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  // Providers registers /sw.js on mount; wait briefly for it, else register here.
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs));
  const reg = await Promise.race([ready, timeout]);
  if (reg) return reg;
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
 *   rotated endpoints land in the database.
 * - `subscribe()` must run inside a tap handler (iOS requirement).
 */
export function usePushSubscription(): PushSubscriptionState {
  const env = useStandalone();
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const resynced = useRef(false);

  // Resync on mount: read the current subscription, re-POST it once.
  useEffect(() => {
    if (!env.ready || !env.pushCapable || resynced.current) return;
    resynced.current = true;
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

  const subscribe = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!env.pushCapable) {
      setError("Notifications are not supported here.");
      return false;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      notifyPermissionChanged();
      if (permission !== "granted") {
        setError(permission === "denied" ? "Notifications are blocked for this app." : "Permission was not granted.");
        return false;
      }
      const reg = await getRegistration();
      if (!reg) {
        setError("The app is not fully installed yet. Reload and try again.");
        return false;
      }
      const key = publicEnv.vapidPublicKey;
      if (!key) {
        setError("Push is not configured on the server.");
        return false;
      }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      }
      const status = await postSubscription(sub);
      if (status === 401) {
        setError("Please log in first.");
        return false;
      }
      if (status >= 400) {
        setError("Could not save your subscription. Try again.");
        return false;
      }
      setEndpoint(sub.endpoint);
      return true;
    } catch (err) {
      setError(err instanceof Error && err.name === "NotAllowedError" ? "Notifications are blocked for this app." : "Could not turn on reminders. Try again.");
      return false;
    } finally {
      setBusy(false);
      setChecked(true);
    }
  }, [env.pushCapable]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await deleteSubscription(sub.endpoint).catch(() => 0);
        await sub.unsubscribe().catch(() => false);
      }
      setEndpoint(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/push/test", { method: "POST", credentials: "include" });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

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
