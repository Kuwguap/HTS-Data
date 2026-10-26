import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { loadSettingsSafe } from "@/components/auth/settings-safe";
import { redirectIfSignedIn } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage() {
  await redirectIfSignedIn();
  const settings = await loadSettingsSafe();
  // Only whether a hostel code is needed crosses to the client; the code itself never does.
  const requiresCode = Boolean(settings.signup_code?.trim());
  return <RegisterForm requiresCode={requiresCode} hostelName={settings.hostel_name} enquiryPhone={settings.enquiry_phone} />;
}
