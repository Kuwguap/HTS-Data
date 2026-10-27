/**
 * Environment access. Public vars are inlined by Next at build time, so they are
 * read directly; server secrets are validated lazily so `next build` does not
 * need them.
 */

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
  appUrl: (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, ""),
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** Server-only secrets. Call inside request handlers, never at module top level. */
export function serverEnv() {
  return {
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
    vapidPublicKey: required("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
    vapidPrivateKey: required("VAPID_PRIVATE_KEY"),
    vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    pinPepper: required("PIN_PEPPER"),
    cronSecret: required("CRON_SECRET"),
  };
}
