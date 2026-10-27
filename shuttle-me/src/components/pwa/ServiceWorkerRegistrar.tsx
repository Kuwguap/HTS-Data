"use client";

import { useEffect } from "react";
import { useToast } from "@/components/ui/Toast";
import { publicEnv } from "@/lib/env";
import { serviceWorkerEnabled } from "@/lib/push/client";
import { VAPID_KEY_MESSAGE } from "@/lib/push/sw-logic";

/** Prefix of every cache sw.js owns (mirrors CACHE_PREFIX in public/sw.js). */
const CACHE_PREFIX = "ks-";
let devCleanupDone = false;

/**
 * In development the worker must not run (it would cache-first Turbopack
 * chunks). Drop any registration and cache a previous production build or an
 * opted-in dev run left behind, once per page load.
 */
async function cleanupDevWorker(): Promise<void> {
  if (devCleanupDone) return;
  devCleanupDone = true;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
    if (regs.length) console.info("[sw] development: unregistered the service worker and cleared its caches");
  } catch (err) {
    console.warn("[sw] development cleanup failed", err);
  }
}

/** Hand the VAPID public key to the active worker so it can re-subscribe on `pushsubscriptionchange`. */
function postVapidKey(reg: ServiceWorkerRegistration): void {
  const key = publicEnv.vapidPublicKey;
  if (!key) return;
  const worker = reg.active ?? navigator.serviceWorker.controller;
  if (worker) worker.postMessage({ type: VAPID_KEY_MESSAGE, key });
}

/**
 * Registers /sw.js once in production builds (or with NEXT_PUBLIC_SW_DEV=1),
 * with updateViaCache: "none" so the browser always checks the network for a
 * new worker. After registration it posts the VAPID public key to the worker.
 * Updates apply by themselves: when a new worker is installed behind a running
 * one it is told to SKIP_WAITING right away (sw.js also calls skipWaiting +
 * clients.claim) and the page reloads once on controllerchange, with a brief
 * "🔄 Updating…" toast — no tap needed. The reload happens at most once per
 * page load and never while the page is hidden; it is deferred to the next
 * visibilitychange → visible instead. Coming back to the foreground also runs
 * registration.update(). In development it instead unregisters any leftover
 * worker and clears the ks-* caches.
 */
export function ServiceWorkerRegistrar() {
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (!serviceWorkerEnabled()) {
      void cleanupDevWorker();
      return;
    }
    // A controller at mount means a worker already ran this page: any later
    // controllerchange is an update. Without one, the first controllerchange is
    // just the first install claiming the page (clients.claim) — never reload for it.
    let hadController = navigator.serviceWorker.controller !== null;
    let reloaded = false;
    let reloadWhenVisible = false;

    const reloadOnce = () => {
      if (reloaded) return;
      if (document.visibilityState !== "visible") {
        reloadWhenVisible = true;
        return;
      }
      reloaded = true;
      toast("🔄 Updating…", { ms: 1500 });
      window.location.reload();
    };

    const onControllerChange = () => {
      // A new worker took over: give it the key too.
      navigator.serviceWorker.ready.then(postVapidKey).catch(() => undefined);
      if (hadController) reloadOnce();
      hadController = true;
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const activateNow = (worker: ServiceWorker) => worker.postMessage({ type: "SKIP_WAITING" });

    const watch = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && navigator.serviceWorker.controller) activateNow(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) activateNow(worker);
        });
      });
    };

    let onVisible: (() => void) | null = null;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        watch(reg);
        // The worker may still be installing: wait for an active one before posting the key.
        navigator.serviceWorker.ready.then(postVapidKey).catch(() => undefined);
        onVisible = () => {
          if (document.visibilityState !== "visible") return;
          // An update that activated while we were hidden reloads now; otherwise look for one.
          if (reloadWhenVisible) {
            reloadWhenVisible = false;
            reloadOnce();
            return;
          }
          reg.update().catch(() => undefined);
        };
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch((err) => {
        console.warn("[sw] registration failed", err);
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [toast]);

  return null;
}
