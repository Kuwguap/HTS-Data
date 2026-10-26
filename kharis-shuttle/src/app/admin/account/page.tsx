import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { ProfileSettings } from "@/components/auth/ProfileSettings";
import { requirePageAuth } from "@/lib/auth/page";
import { publicProfile } from "@/lib/auth/session";
import { getSettings } from "@/lib/data/settings";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

/** Admin "My account": the shared <ProfileSettings/> body (profile, reminders, PIN, log out). */
export default async function AdminAccountPage() {
  const { profile } = await requirePageAuth({ role: "admin" });
  const settings = await getSettings();
  return (
    <Page>
      <AppHeader title="My account" back="/admin/more" greeting={settings.hostel_name} />
      <ProfileSettings profile={publicProfile(profile)} appVersion={pkg.version} enquiryPhone={settings.enquiry_phone} />
    </Page>
  );
}
