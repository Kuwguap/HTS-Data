"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db.types";
import { publicEnv } from "@/lib/env";

let browserClient: SupabaseClient<Database> | undefined;

/**
 * Browser Supabase client (RLS-scoped, session from cookies).
 * One instance per tab so Realtime channels share a socket.
 */
export function createClient(): SupabaseClient<Database> {
  if (!browserClient) {
    browserClient = createBrowserClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseKey);
  }
  return browserClient;
}
