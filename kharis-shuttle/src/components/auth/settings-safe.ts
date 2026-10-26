import "server-only";

import type { ScheduleTime, Settings } from "@/lib/db.types";
import { DEFAULT_SETTINGS, getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { isoWeekday, localDateString } from "@/lib/time";

/** Resolve `promise`, or `fallback` if it rejects or takes longer than `ms`. */
export async function settled<T>(promise: Promise<T>, fallback: T, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Hostel settings for public and auth pages. Never throws and never hangs: with
 * no database (placeholder env) the defaults come back after a short wait.
 */
export async function loadSettingsSafe(): Promise<Settings> {
  return settled(getSettings(), DEFAULT_SETTINGS);
}

export type TodaySchedule = {
  /** Local calendar date, e.g. "2026-10-27". */
  date: string;
  toCampus: ScheduleTime[];
  toHostel: ScheduleTime[];
  /** Set when today is listed in service_days_off. */
  dayOff: { reason: string | null } | null;
};

const EMPTY = (date: string): TodaySchedule => ({ date, toCampus: [], toHostel: [], dayOff: null });

/** Today's active timetable grouped by direction. Empty (not an error) when the DB is unreachable. */
export async function loadTodaySchedule(settings: Pick<Settings, "timezone">, now = new Date()): Promise<TodaySchedule> {
  const date = localDateString(now, settings.timezone);
  const weekday = isoWeekday(now, settings.timezone);
  const load = async (): Promise<TodaySchedule> => {
    const admin = createAdminClient();
    const [times, off] = await Promise.all([
      admin
        .from("schedule_times")
        .select("*")
        .eq("is_active", true)
        .contains("days_of_week", [weekday])
        .order("depart_time", { ascending: true }),
      admin.from("service_days_off").select("reason").eq("service_date", date).maybeSingle(),
    ]);
    const rows = times.data ?? [];
    return {
      date,
      toCampus: rows.filter((r) => r.direction === "to_campus"),
      toHostel: rows.filter((r) => r.direction === "to_hostel"),
      dayOff: off.data ? { reason: off.data.reason } : null,
    };
  };
  return settled(load(), EMPTY(date));
}
