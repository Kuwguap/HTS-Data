/**
 * Browser-side push helpers. Safe to import from server code (nothing runs at
 * module load), but every function here expects `window`.
 */
import { detectPlatform } from "@/lib/geo";
import { subscriptionBody } from "@/lib/push/sw-logic";

/** VAPID public key (URL-safe base64) → the `applicationServerKey` bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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
