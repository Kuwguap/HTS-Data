import type { Metadata } from "next";
import { WelcomeFlow } from "@/components/auth/WelcomeFlow";
import { loadSettingsSafe } from "@/components/auth/settings-safe";
import { requirePageAuth } from "@/lib/auth/page";
import { publicProfile } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Welcome" };

/** Onboarding gate: install → reminders → details. Every role passes through once. */
export default async function WelcomePage() {
  const { profile } = await requirePageAuth({ allowUnonboarded: true });
  const settings = await loadSettingsSafe();
  return (
    <WelcomeFlow
      profile={publicProfile(profile)}
      settings={{ hostel_name: settings.hostel_name, campus_name: settings.campus_name, enquiry_phone: settings.enquiry_phone }}
    />
  );
}
