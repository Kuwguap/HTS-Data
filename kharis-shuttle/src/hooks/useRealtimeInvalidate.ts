"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export type RealtimeInvalidateOptions = {
  /** Table in the `public` schema (must be in the supabase_realtime publication). */
  table: "trips" | "bookings" | "pickup_requests" | "notifications";
  /** PostgREST-style filter, e.g. `trip_id=eq.<uuid>`. */
  filter?: string;
  /** Default "*" (INSERT, UPDATE and DELETE). */
  event?: "*" | "INSERT" | "UPDATE" | "DELETE";
  /** Debounce window before router.refresh() (default 400 ms). */
  debounceMs?: number;
  /** Set false to pause (e.g. while a sheet is open). */
  enabled?: boolean;
  /** Called (debounced) in addition to the refresh. */
  onChange?: () => void;
};

/**
 * Subscribe to postgres_changes on one table and `router.refresh()` the current
 * Server Component tree (debounced) whenever a row changes. RLS applies, so a
 * driver sees every booking / request, a student only their own.
 */
export function useRealtimeInvalidate({ table, filter, event = "*", debounceMs = 400, enabled = true, onChange }: RealtimeInvalidateOptions): void {
  const router = useRouter();
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled) return;
    let channel: RealtimeChannel | null = null;
    let timer: number | null = null;
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch {
      return;
    }

    const bump = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        onChangeRef.current?.();
        router.refresh();
      }, debounceMs);
    };

    const name = `inv:${table}:${filter ?? "all"}:${Math.random().toString(36).slice(2, 8)}`;
    const spec = filter ? { event, schema: "public", table, filter } : { event, schema: "public", table };
    channel = supabase.channel(name).on("postgres_changes", spec, bump).subscribe();

    return () => {
      if (timer) window.clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [table, filter, event, debounceMs, enabled, router]);
}
