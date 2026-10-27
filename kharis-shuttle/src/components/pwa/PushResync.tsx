"use client";

import { useEffect } from "react";
import { resyncDeviceSubscription } from "@/lib/push/client";

/**
 * Re-attaches this device's existing push subscription to the signed-in user.
 * Mounted in every role shell, so it runs whenever a shell mounts: on a hard load
 * and again after a logout + login on a shared phone (the login navigation mounts
 * the next person's shell), so the next person re-claims the device silently. The
 * POST is an idempotent upsert on the endpoint, so running twice (StrictMode, two
 * shells in one session) is harmless. Never prompts: it only acts when
 * Notification.permission is already "granted". Renders nothing.
 */
export function PushResync() {
  useEffect(() => {
    void resyncDeviceSubscription();
  }, []);
  return null;
}
