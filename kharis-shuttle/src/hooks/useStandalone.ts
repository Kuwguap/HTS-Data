"use client";

import { useSyncExternalStore } from "react";
import { isAndroid, isIOS, isIOSSafari, isStandalone, notificationPermission, pushSupported } from "@/lib/push/client";

export type StandaloneInfo = {
  /** False during SSR and the first client render; the rest are defaults until then. */
  ready: boolean;
  isIOS: boolean;
  /** iOS Safari proper (where "Add to Home Screen" lives), not Chrome/in-app browsers. */
  isIOSSafari: boolean;
  isAndroid: boolean;
  /** Running as an installed home-screen app. */
  isStandalone: boolean;
  /** Web Push API available in this context (on iOS only inside the installed app). */
  pushCapable: boolean;
  permission: NotificationPermission | "unsupported";
};

const SERVER: StandaloneInfo = {
  ready: false,
  isIOS: false,
  isIOSSafari: false,
  isAndroid: false,
  isStandalone: false,
  pushCapable: false,
  permission: "unsupported",
};

let cached: StandaloneInfo = SERVER;
let cachedKey = "";

function compute(): StandaloneInfo {
  const next: StandaloneInfo = {
    ready: true,
    isIOS: isIOS(),
    isIOSSafari: isIOSSafari(),
    isAndroid: isAndroid(),
    isStandalone: isStandalone(),
    pushCapable: pushSupported(),
    permission: notificationPermission(),
  };
  const key = JSON.stringify(next);
  if (key !== cachedKey) {
    cachedKey = key;
    cached = next;
  }
  return cached;
}

function subscribe(onChange: () => void) {
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener("change", onChange);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("kharis:permission", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("kharis:permission", onChange);
  };
}

/** Tell every useStandalone() subscriber that Notification.permission may have changed. */
export function notifyPermissionChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("kharis:permission"));
}

/**
 * Client-only facts about where the app is running (SSR-safe: returns
 * defaults with `ready: false` on the server and during hydration).
 */
export function useStandalone(): StandaloneInfo {
  return useSyncExternalStore(subscribe, compute, () => SERVER);
}
