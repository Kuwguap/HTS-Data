"use client";

import { useEffect } from "react";
import { EMBEDDED_BUILD_COMMIT, isRealCommit, shouldCheckBuild, shouldReloadForBuild } from "@/lib/pwa/build-check";

/**
 * Reloads the page when the running bundle is older than the deployed one: on
 * every visibilitychange → visible (at most once per 60 s) it fetches /api/health
 * (no-store) and compares `commit` with the embedded NEXT_PUBLIC_BUILD_COMMIT.
 * Does nothing in dev or when either side has no commit. Mounted once in the
 * root layout next to ServiceWorkerRegistrar.
 */
export function BuildRefresh() {
  useEffect(() => {
    if (typeof window === "undefined" || !isRealCommit(EMBEDDED_BUILD_COMMIT)) return;
    let lastCheckedAt: number | null = null;
    let reloading = false;

    const check = async () => {
      const now = Date.now();
      const previous = lastCheckedAt;
      if (reloading || !shouldCheckBuild(previous, now)) return;
      lastCheckedAt = now;
      try {
        const res = await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) return;
        const body = (await res.json()) as { commit?: string | null };
        if (document.visibilityState !== "visible") return;
        if (shouldReloadForBuild(EMBEDDED_BUILD_COMMIT, body.commit ?? null, previous, now)) {
          reloading = true;
          window.location.reload();
        }
      } catch {
        // offline: the next foreground will try again
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return null;
}
