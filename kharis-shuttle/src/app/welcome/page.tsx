import type { Metadata } from "next";
import { firstParam } from "@/components/auth/redirect-signed-in";
import { WelcomeFlow } from "@/components/auth/WelcomeFlow";
import { loadSettingsSafe } from "@/components/auth/settings-safe";
import { requirePageAuth } from "@/lib/auth/page";
import { publicProfile } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Welcome" };

type SearchParams = Promise<{ next?: string | string[] }>;

/** Onboarding gate: install → reminders → details. Every role passes through once. */
export default async function WelcomePage({ searchParams }: { searchParams: SearchParams }) {
  const { profile } = await requirePageAuth({ allowUnonboarded: true });
  const sp = await searchParams;
  // Where /login or /register wanted to send them; same-origin only, else the role home.
  const next = safeNextPath(firstParam(sp.next), "") || undefined;
  const settings = await loadSettingsSafe();
  return (
    <WelcomeFlow
      profile={publicProfile(profile)}
      settings={{ hostel_name: settings.hostel_name, campus_name: settings.campus_name, enquiry_phone: settings.enquiry_phone }}
      next={next}
    />
  );
}
