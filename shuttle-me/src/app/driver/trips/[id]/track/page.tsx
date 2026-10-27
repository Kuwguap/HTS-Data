import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageAuth } from "@/lib/auth/page";
import { getTrip } from "@/lib/data/driver";
import { getActivePickupLocations, getSettings } from "@/lib/data/settings";
import { TrackingPanel } from "@/components/driver/TrackingPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Live tracking" };

export default async function DriverTrackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAuth({ role: "driver" });
  const [trip, settings, pickupLocations] = await Promise.all([getTrip(id), getSettings(), getActivePickupLocations()]);
  if (!trip) notFound();
  return (
    <TrackingPanel
      trip={trip}
      pickupLocations={pickupLocations.filter((p) => p.direction === null || p.direction === trip.direction)}
      settings={{
        timezone: settings.timezone,
        location_stale_seconds: settings.location_stale_seconds,
        hostel_name: settings.hostel_name,
        campus_name: settings.campus_name,
      }}
    />
  );
}
