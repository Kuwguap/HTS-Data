/**
 * Browser-side push helpers. Safe to import from server code (nothing runs at
 * module load), but every function here expects `window`.
 */
import { detectPlatform } from "@/lib/geo";
import { subscriptionBody, urlBase64ToUint8Array } from "@/lib/push/sw-logic";

export { urlBase64ToUint8Array };

/**
 * Whether /sw.js should be registered in this build. Off in development (the
 * worker would cache-first Turbopack chunks and serve stale code); opt in
 * locally with NEXT_PUBLIC_SW_DEV=1. Both values are inlined at build time.
 */
export function serviceWorkerEnabled(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SW_DEV === "1";
}

function ua(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

/** iPhone / iPad (including iPadOS pretending to be a Mac). */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return detectPlatform(ua(), navigator.maxTouchPoints ?? 0, navigator.platform ?? "") === "ios";
}

export function isAndroid(): boolean {
  return /android/i.test(ua());
}

/** True inside an installed PWA (home-screen app) on iOS, Android or desktop. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: window-controls-overlay)").matches
    );
  } catch {
    return false;
  }
}

/** iOS Safari itself (not Chrome/Firefox/in-app webviews), which is where "Add to Home Screen" lives. */
export function isIOSSafari(): boolean {
  const s = ua();
  return isIOS() && /safari/i.test(s) && !/crios|fxios|edgios|opios|fbav|fban|instagram|line\/|twitter/i.test(s);
}

/** Web Push can work in this context (Notification + PushManager + service worker present). */
export function pushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export function platformOf(): "ios" | "android" | "desktop" | "other" {
  if (typeof navigator === "undefined") return "other";
  return detectPlatform(ua(), navigator.maxTouchPoints ?? 0, navigator.platform ?? "");
}

/** JSON body for POST /api/push/subscribe. */
export function subscribeBody(sub: PushSubscription) {
  const body = subscriptionBody(sub.toJSON(), ua());
  return { ...body, platform: platformOf() };
}

/** POST the subscription to the server (idempotent upsert on endpoint). Resolves to the HTTP status. */
export async function postSubscription(sub: PushSubscription): Promise<number> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscribeBody(sub)),
  });
  return res.status;
}

/** Tell the server this endpoint is gone. */
export async function deleteSubscription(endpoint: string): Promise<number> {
  const res = await fetch("/api/push/subscribe", {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  return res.status;
}

/**
 * The device's current PushSubscription, or null. Reads only: never registers the
 * worker (`getRegistration`, not `.ready`, which never resolves without one) and
 * never touches Notification permission.
 */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof window === "undefined" || !serviceWorkerEnabled() || !("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Before logging out: detach this device's push endpoint from the signed-in user
 * (DELETE /api/push/subscribe is scoped to the caller). The browser subscription is
 * kept so the next person to log in on this phone re-claims it silently via
 * `resyncDeviceSubscription()`. Best effort: errors are swallowed.
 */
export async function detachDeviceSubscription(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (sub) await deleteSubscription(sub.endpoint);
  } catch {
    // Best effort; the logout must go ahead regardless.
  }
}

/**
 * After signing in / on every app load: if notifications are already granted and the
 * device holds a subscription, re-POST it so the row is attached to the current user
 * (upsert on endpoint). Never prompts for permission. Best effort: errors are swallowed.
 */
export async function resyncDeviceSubscription(): Promise<void> {
  try {
    if (notificationPermission() !== "granted") return;
    const sub = await currentSubscription();
    if (sub) await postSubscription(sub);
  } catch {
    // Signed-out pages answer 401 and a missing worker just means nothing to do.
  }
}
