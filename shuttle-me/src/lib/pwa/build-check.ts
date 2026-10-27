/**
 * Stale-build detection for installed PWAs. iOS resumes a home-screen app from
 * memory with whatever JS it had, sometimes days old, and the service worker
 * only updates when its own bytes change. So on every return to the foreground
 * the app compares the commit baked into its bundle (NEXT_PUBLIC_BUILD_COMMIT,
 * set in next.config.ts from VERCEL_GIT_COMMIT_SHA) with the one /api/health
 * reports, and reloads when they differ. Pure helpers here; BuildRefresh.tsx
 * does the fetching.
 */

/** Minimum gap between two /api/health checks. */
export const BUILD_CHECK_INTERVAL_MS = 60_000;

/** Commit baked into this bundle ("dev" outside Vercel builds, null when unset). */
export const EMBEDDED_BUILD_COMMIT: string | null = process.env.NEXT_PUBLIC_BUILD_COMMIT || null;

/** A value that identifies no real build (local dev, unset env). */
export function isRealCommit(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value !== "dev";
}

/** Whether a check may run now: never more than once per BUILD_CHECK_INTERVAL_MS. */
export function shouldCheckBuild(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt == null || now - lastCheckedAt >= BUILD_CHECK_INTERVAL_MS;
}

/**
 * The reload decision: both commits are real (non-null, not "dev"), they differ, and
 * `lastCheckedAt` (the previous check, null for the first) does not throttle this one.
 */
export function shouldReloadForBuild(embedded: string | null | undefined, served: string | null | undefined, lastCheckedAt: number | null, now: number): boolean {
  if (!shouldCheckBuild(lastCheckedAt, now)) return false;
  if (!isRealCommit(embedded) || !isRealCommit(served)) return false;
  return embedded !== served;
}
