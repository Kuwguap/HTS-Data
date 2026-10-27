import "server-only";

import { cache } from "react";
import type { PickupLocation, Settings } from "@/lib/db.types";
import { createAdminClient } from "@/lib/supabase/admin";

export const DEFAULT_SETTINGS: Settings = {
  id: 1,
  hostel_name: "Kharis Courts Hostel",
  campus_name: "KNUST",
  timezone: "Africa/Accra",
  fare_pesewas: 1000,
  currency: "GHS",
  payment_note: "Cash only — pay the driver when you board",
  enquiry_phone: null,
  default_seat_capacity: 14,
  reminder_lead_minutes: 60,
  nudge_minutes: 10,
  manifest_lead_minutes: 15,
  booking_cutoff_minutes: 5,
  booking_open_days_ahead: 1,
  daily_announcement_enabled: true,
  daily_announcement_time: "06:00:00",
  location_stale_seconds: 90,
  signup_code: null,
  default_driver_id: null,
  hostel_lat: null,
  hostel_lng: null,
  campus_lat: null,
  campus_lng: null,
  updated_at: new Date(0).toISOString(),
  updated_by: null,
};

/** Hostel settings (singleton row). Cached per request. Falls back to defaults if missing. */
export const getSettings = cache(async (): Promise<Settings> => {
  const admin = createAdminClient();
  const { data } = await admin.from("settings").select("*").eq("id", 1).maybeSingle();
  return data ?? DEFAULT_SETTINGS;
});

/** Active pickup locations in display order. Cached per request. */
export const getActivePickupLocations = cache(async (): Promise<PickupLocation[]> => {
  const admin = createAdminClient();
  const { data } = await admin
    .from("pickup_locations")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  return data ?? [];
});
