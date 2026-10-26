"use client";

import { useEffect } from "react";
import { useToast } from "@/components/ui/Toast";

/**
 * Registers /sw.js once (updateViaCache: "none" so the browser always checks
 * the network for a new worker). When a new worker is installed behind a
 * running one, shows "🔄 Update ready — tap to reload"; tapping asks the worker
 * to activate and reloads once control changes.
 */
export function ServiceWorkerRegistrar() {
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    let refreshing = false;
    let wantReload = false;

    const onControllerChange = () => {
      if (refreshing || !wantReload) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const offerUpdate = (worker: ServiceWorker) => {
      toast("🔄 Update ready — tap to reload", {
        ms: 0,
        onTap: () => {
          wantReload = true;
          if (worker.state === "activated" || navigator.serviceWorker.controller !== null) {
            // Already swapped (sw.js calls skipWaiting on install): just reload.
            worker.postMessage({ type: "SKIP_WAITING" });
            window.setTimeout(() => {
              if (!refreshing) {
                refreshing = true;
                window.location.reload();
              }
            }, 400);
          } else {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        },
      });
    };

    const watch = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        watch(reg);
        // Check for a new worker whenever the app comes back to the foreground.
        const onVisible = () => {
          if (document.visibilityState === "visible") reg.update().catch(() => undefined);
        };
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch((err) => {
        console.warn("[sw] registration failed", err);
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, [toast]);

  return null;
}
