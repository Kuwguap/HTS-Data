import type { Metadata } from "next";
import { requirePageAuth } from "@/lib/auth/page";
import { getSettings } from "@/lib/data/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { AnnounceForm } from "@/components/driver/AnnounceForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Announce a return trip" };

const DEFAULT_TEMPLATE = {
  title: "🚌 Shuttle heading to {hostel}",
  body: "Shuttle at {origin} → {hostel}. Leaving in {count} min. Tap if you're coming.",
};

/** "Shuttle is at KSB heading to the hostel" — creates an ad-hoc trip, pushes everyone, jumps to tracking. */
export default async function DriverAnnouncePage() {
  await requirePageAuth({ role: "driver" });
  const settings = await getSettings();
  const admin = createAdminClient();
  const { data: tpl } = await admin.from("message_templates").select("title, body").eq("key", "return_announcement").maybeSingle();

  return (
    <Page>
      <AppHeader back="/driver" title="Return trip" greeting="Tell everyone you're leaving" />
      <AnnounceForm
        settings={{
          hostel_name: settings.hostel_name,
          campus_name: settings.campus_name,
          default_seat_capacity: settings.default_seat_capacity,
          fare_pesewas: settings.fare_pesewas,
          currency: settings.currency,
        }}
        template={tpl ?? DEFAULT_TEMPLATE}
      />
    </Page>
  );
}
