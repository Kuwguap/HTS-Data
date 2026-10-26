import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db.types";
import { serverEnv } from "@/lib/env";

let adminClient: SupabaseClient<Database> | undefined;

/**
 * Service-role client. Bypasses RLS: only use inside route handlers / server code
 * after an explicit role check (see lib/auth/require.ts).
 */
export function createAdminClient(): SupabaseClient<Database> {
  if (!adminClient) {
    const env = serverEnv();
    adminClient = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return adminClient;
}
