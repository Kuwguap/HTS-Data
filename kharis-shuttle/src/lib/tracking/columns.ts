/** Columns the location trigger rewrites on trips (at most every 15 s); refreshes should not fire for these alone. */
export const TRIP_LOCATION_COLUMNS: readonly string[] = ["last_lat", "last_lng", "last_heading", "last_speed_mps", "last_location_at"];

/**
 * True when a postgres_changes UPDATE touched only ignored columns. Needs the
 * full old row (replica identity full); an `old` that carries just the primary
 * key (or nothing) cannot be judged, so the change counts as relevant.
 */
export function isIgnorableChange(oldRow: unknown, newRow: unknown, ignoreColumns: readonly string[]): boolean {
  if (ignoreColumns.length === 0) return false;
  if (!oldRow || typeof oldRow !== "object" || !newRow || typeof newRow !== "object") return false;
  const o = oldRow as Record<string, unknown>;
  const n = newRow as Record<string, unknown>;
  const oldKeys = Object.keys(o);
  if (oldKeys.length <= 1) return false;
  const ignore = new Set(ignoreColumns);
  const keys = new Set([...oldKeys, ...Object.keys(n)]);
  let differing = 0;
  for (const k of keys) {
    if (Object.is(o[k], n[k])) continue;
    if (!ignore.has(k)) return false;
    differing += 1;
  }
  return differing > 0;
}
