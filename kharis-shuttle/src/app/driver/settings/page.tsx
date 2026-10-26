import type { Metadata } from "next";
import { ProfileSettings } from "@/components/auth/ProfileSettings";
import { requirePageAuth } from "@/lib/auth/page";
import { publicProfile } from "@/lib/auth/session";
import { getSettings } from "@/lib/data/settings";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Me" };

/** Driver "Me" tab: the shared <ProfileSettings/> body (profile, reminders, PIN, log out). */
export default async function DriverSettingsPage() {
  const { profile } = await requirePageAuth({ role: "driver" });
  const settings = await getSettings();
  return (
    <Page>
      <AppHeader title="Me" greeting={profile.full_name} />
      <ProfileSettings profile={publicProfile(profile)} appVersion={pkg.version} enquiryPhone={settings.enquiry_phone} />
    </Page>
  );
}
