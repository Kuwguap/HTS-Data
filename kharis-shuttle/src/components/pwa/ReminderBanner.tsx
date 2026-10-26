"use client";

import { useSyncExternalStore } from "react";
import { useStandalone } from "@/hooks/useStandalone";
import { Banner } from "@/components/ui/Banner";

const DISMISS_KEY = "kharis:reminder-banner-dismissed";
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function dismissForSession() {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // private mode: just hide for this render
  }
  listeners.forEach((l) => l());
}

export type ReminderBannerProps = {
  /** Where "Turn on" goes (default /welcome). */
  href?: string;
  /** Allow hiding it for this session with ✕ (default true). */
  dismissible?: boolean;
  className?: string;
};

/**
 * Slim amber strip shown while reminders are off: either the app is not
 * installed on iPhone, or notification permission is not granted. Hidden once
 * permission is granted, before hydration, and after the user dismisses it.
 */
export function ReminderBanner({ href = "/welcome", dismissible = true, className }: ReminderBannerProps) {
  const env = useStandalone();
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => false);

  if (!env.ready || dismissed) return null;
  if (env.permission === "granted") return null;

  const needsInstall = env.isIOS && !env.isStandalone;
  if (!needsInstall && !env.pushCapable) return null;

  return (
    <Banner
      tone="amber"
      icon="🔔"
      action={{ label: needsInstall ? "Install" : "Turn on", href }}
      onDismiss={dismissible ? dismissForSession : undefined}
      className={className}
    >
      {needsInstall ? "Add the app to your Home Screen to get shuttle reminders." : "Reminders are off — you could miss the shuttle."}
    </Banner>
  );
}
