/**
 * Time helpers. The hostel runs on settings.timezone (Africa/Accra, UTC+0, no DST),
 * but every helper takes the zone explicitly so nothing assumes UTC.
 */

export const DEFAULT_TZ = "Africa/Accra";

function parts(date: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

export function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "2026-10-27" for the given instant in the zone. */
export function localDateString(value: string | number | Date, timeZone = DEFAULT_TZ): string {
  const p = parts(toDate(value), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "7:30 AM" */
export function formatTime(value: string | number | Date, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(toDate(value))
    .replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toUpperCase()}`);
}

/** "Mon 27 Oct" */
export function formatShortDate(value: string | number | Date, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(
    toDate(value),
  );
}

/** "Today" / "Tomorrow" / "Yesterday" / "Mon 27 Oct" relative to `now`. */
export function formatDayLabel(value: string | number | Date, now: Date = new Date(), timeZone = DEFAULT_TZ): string {
  const target = localDateString(value, timeZone);
  const today = localDateString(now, timeZone);
  if (target === today) return "Today";
  const tomorrow = localDateString(addDays(now, 1), timeZone);
  if (target === tomorrow) return "Tomorrow";
  const yesterday = localDateString(addDays(now, -1), timeZone);
  if (target === yesterday) return "Yesterday";
  return formatShortDate(value, timeZone);
}

/** "Today, 7:30 AM" */
export function formatDayTime(value: string | number | Date, now: Date = new Date(), timeZone = DEFAULT_TZ): string {
  return `${formatDayLabel(value, now, timeZone)}, ${formatTime(value, timeZone)}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function minutesBetween(a: string | number | Date, b: string | number | Date): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 60_000);
}

export function secondsSince(value: string | number | Date | null | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  return Math.max(0, Math.round((now.getTime() - toDate(value).getTime()) / 1000));
}

/** "just now", "45s ago", "3 min ago", "2 h ago" */
export function formatAgo(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const s = secondsSince(value, now);
  if (s == null) return "never";
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "in 12 min", "in 2 h 5 min", "now", "5 min ago" */
export function formatCountdown(value: string | number | Date, now: Date = new Date()): string {
  const m = minutesBetween(now, value);
  if (m <= 0 && m > -1) return "now";
  if (m < 0) return `${Math.abs(m)} min ago`;
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `in ${h} h ${rest} min` : `in ${h} h`;
}

export function isStale(lastAt: string | number | Date | null | undefined, staleSeconds: number, now: Date = new Date()): boolean {
  const s = secondsSince(lastAt, now);
  return s == null || s > staleSeconds;
}

/** Build an instant from a local date + time in the zone, e.g. ("2026-10-27", "07:30") → Date. */
export function zonedDateTime(dateStr: string, timeStr: string, timeZone = DEFAULT_TZ): Date {
  const [y, mo, d] = dateStr.split("-").map(Number) as [number, number, number];
  const [h, mi, s = 0] = timeStr.split(":").map(Number) as [number, number, number?];
  // First guess as if UTC, then correct by the zone offset at that instant.
  const guess = Date.UTC(y, mo - 1, d, h, mi, s ?? 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const corrected = guess - offset;
  // One more pass handles the (non-existent in Accra) DST edge.
  const offset2 = zoneOffsetMs(new Date(corrected), timeZone);
  return new Date(guess - offset2);
}

/** Offset of the zone from UTC at the given instant, in ms (east positive). */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - date.getTime();
}

/** ISO weekday 1 (Mon) … 7 (Sun) in the zone. */
export function isoWeekday(value: string | number | Date, timeZone = DEFAULT_TZ): number {
  const p = parts(toDate(value), timeZone);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[p.weekday ?? "Mon"] ?? 1;
}

export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "Mon–Fri", "Mon, Wed, Fri", "Every day" */
export function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  if (sorted.join(",") === "1,2,3,4,5") return "Mon–Fri";
  if (sorted.join(",") === "6,7") return "Weekends";
  return sorted.map((d) => WEEKDAY_SHORT[d]).join(", ");
}

/** "07:30:00" → "7:30 AM" without a date. */
export function formatClock(time: string): string {
  const [h = 0, m = 0] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** GH₵10 / GH₵12.50 */
export function formatFare(pesewas: number, currency = "GHS"): string {
  const symbol = currency === "GHS" ? "GH₵" : `${currency} `;
  const cedis = pesewas / 100;
  return `${symbol}${Number.isInteger(cedis) ? cedis : cedis.toFixed(2)}`;
}
