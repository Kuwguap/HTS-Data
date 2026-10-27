"use client";

import { useRealtimeInvalidate, type RealtimeInvalidateOptions } from "@/hooks/useRealtimeInvalidate";

/**
 * Renders nothing; refreshes the current Server Component tree when rows in the
 * given table change (via useRealtimeInvalidate). Drop one per table to watch.
 */
export function LiveRefresh(props: RealtimeInvalidateOptions) {
  useRealtimeInvalidate(props);
  return null;
}
