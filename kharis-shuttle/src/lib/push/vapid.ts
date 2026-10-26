import webpush from "web-push";
import { serverEnv } from "@/lib/env";

let configured = false;

/**
 * The `web-push` module, with VAPID details applied exactly once per process.
 * Call inside request handlers / the drain, never at module top level (the env
 * is validated lazily so `next build` does not need the private key).
 */
export function getWebPush(): typeof webpush {
  if (!configured) {
    const env = serverEnv();
    webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
    configured = true;
  }
  return webpush;
}

/** Test hook: forget that VAPID was configured (e.g. after changing env vars). */
export function resetWebPushForTests(): void {
  configured = false;
}
