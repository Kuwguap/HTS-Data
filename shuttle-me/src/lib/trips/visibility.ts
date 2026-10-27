import { addDays, localDateString } from "@/lib/time";

/**
 * Same window as the trips RLS policy (0006_rls.sql): students see trips from
 * local yesterday onwards; staff see everything. Older trips read as missing from
 * the service-role routes (/api/trips/[id]/location, /route, /matched).
 */
export function withinStudentWindow(serviceDate: string, timeZone: string, now = new Date()): boolean {
  return serviceDate >= localDateString(addDays(now, -1), timeZone);
}
