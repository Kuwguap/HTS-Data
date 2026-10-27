"use client";

import { useEffect } from "react";
import { resyncDeviceSubscription } from "@/lib/push/client";

/** Set once the resync has run in this page load (survives StrictMode double-mount and layout changes). */
let ran = false;

/**
 * Re-attaches this device's existing push subscription to the signed-in user, at
 * most once per page load. Mounted in every role shell so that after a logout +
 * login on a shared phone the next person re-claims the device silently (the row
 * is upserted on endpoint by POST /api/push/subscribe). Never prompts: it only
 * acts when Notification.permission is already "granted". Renders nothing.
 */
export function PushResync() {
  useEffect(() => {
    if (ran) return;
    ran = true;
    void resyncDeviceSubscription();
  }, []);
  return null;
}
