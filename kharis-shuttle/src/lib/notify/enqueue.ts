/**
 * App-side notification helpers. Every push also lands in the inbox: rows are
 * written through the SQL `enqueue_notification` function (templates rendered in
 * SQL, deduplicated per recipient) and delivered by `drainOutbox`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import type { Database, Json, NotificationKind } from "@/lib/db.types";
import { drainOutbox, type DrainOptions, type DrainResult } from "@/lib/push/drain";
import type { Urgency } from "@/lib/push/send";

type Admin = SupabaseClient<Database>;

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

export type EnqueueInput = {
  userIds: string[];
  kind: NotificationKind;
  /** Placeholder values for the message template ({time}, {fare}, {pickup}, …). */
  vars?: TemplateVars;
  /** Same-origin path the notification opens, e.g. "/app/trips/<id>". */
  url?: string | null;
  /**
   * Dedupe prefix: `<prefix>:<user_id>` must be unique, so the same event never
   * notifies the same person twice (e.g. "booking_confirmed:<booking_id>").
   */
  dedupePrefix: string;
  /** Seconds the push service keeps the message (default 3600). */
  ttlSeconds?: number;
  urgency?: Urgency;
  /** Notifications with the same tag replace each other on the device. */
  collapseTag?: string | null;
};

function cleanVars(vars: TemplateVars | undefined): Json {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (v === undefined) continue;
    out[k] = v === null ? null : typeof v === "boolean" ? String(v) : v;
  }
  return out;
}

/** Enqueue one notification per recipient. Resolves to the number of rows inserted. */
export async function enqueueNotification(admin: Admin, input: EnqueueInput): Promise<number> {
  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (userIds.length === 0) return 0;
  const { data, error } = await admin.rpc("enqueue_notification", {
    p_user_ids: userIds,
    p_kind: input.kind,
    p_vars: cleanVars(input.vars),
    p_url: input.url ?? null,
    p_dedupe_prefix: input.dedupePrefix,
    p_ttl_seconds: input.ttlSeconds ?? 3600,
    p_urgency: input.urgency ?? "normal",
    p_collapse_tag: input.collapseTag ?? null,
  });
  if (error) {
    console.error(`[notify] enqueue ${input.kind} failed:`, error.message);
    return 0;
  }
  return typeof data === "number" ? data : 0;
}

/** Active students; `remindersOnly` keeps only those with reminders switched on. */
export async function listActiveStudentIds(admin: Admin, opts: { remindersOnly?: boolean } = {}): Promise<string[]> {
  let query = admin.from("profiles").select("id").eq("role", "student").eq("is_active", true);
  if (opts.remindersOnly) query = query.eq("reminders_enabled", true);
  const { data, error } = await query;
  if (error) {
    console.error("[notify] listActiveStudentIds failed:", error.message);
    return [];
  }
  return (data ?? []).map((p) => p.id);
}

/**
 * Who should hear about a trip's events: the assigned driver when there is one
 * (and still active), otherwise every active driver; admins only when no driver exists.
 */
export async function listDriverIds(admin: Admin, tripDriverId?: string | null): Promise<string[]> {
  if (tripDriverId) {
    const { data } = await admin
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", tripDriverId)
      .maybeSingle();
    if (data && data.is_active && (data.role === "driver" || data.role === "admin")) return [data.id];
  }
  const { data: drivers, error } = await admin.from("profiles").select("id").eq("role", "driver").eq("is_active", true);
  if (error) {
    console.error("[notify] listDriverIds failed:", error.message);
    return [];
  }
  if (drivers && drivers.length > 0) return drivers.map((p) => p.id);
  const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
  return (admins ?? []).map((p) => p.id);
}

/** Budget for a drain that runs after an app response (keeps serverless functions short). */
export const AFTER_DRAIN_BUDGET_MS = 25_000;

/**
 * Enqueue, then push right away without delaying the response: inside a request
 * the drain is scheduled with `after()`; anywhere else (scripts, tests) it runs
 * inline. Resolves to the number of rows enqueued.
 */
export async function notifyAndDrain(
  admin: Admin,
  input: EnqueueInput,
  drainOptions: Omit<DrainOptions, "admin"> = {},
): Promise<number> {
  const count = await enqueueNotification(admin, input);
  if (count > 0) await scheduleDrain({ admin, budgetMs: AFTER_DRAIN_BUDGET_MS, ...drainOptions });
  return count;
}

/**
 * Run the drain after the current response when possible, otherwise now.
 * Returns the drain result only when it ran inline.
 */
export async function scheduleDrain(options: DrainOptions = {}): Promise<DrainResult | null> {
  const run = () =>
    drainOutbox(options).catch((err: unknown) => {
      console.error("[notify] drain failed:", err instanceof Error ? err.message : err);
      return null;
    });
  try {
    after(run);
    return null;
  } catch {
    // Not inside a Next request scope (script, test, cron worker): drain inline.
    return run();
  }
}
