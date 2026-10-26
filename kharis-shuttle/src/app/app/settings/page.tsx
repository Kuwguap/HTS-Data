import type { Metadata } from "next";
import { ProfileSettings } from "@/components/auth/ProfileSettings";
import { loadSettingsSafe } from "@/components/auth/settings-safe";
import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { requirePageAuth } from "@/lib/auth/page";
import { publicProfile } from "@/lib/auth/session";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Me" };

/** Student "Me" tab. Drivers and admins get their own page that reuses <ProfileSettings>. */
export default async function StudentSettingsPage() {
  const { profile } = await requirePageAuth();
  const settings = await loadSettingsSafe();
  return (
    <Page>
      <AppHeader title="Me" greeting={settings.hostel_name} />
      <ProfileSettings profile={publicProfile(profile)} appVersion={pkg.version} enquiryPhone={settings.enquiry_phone} />
    </Page>
  );
}
