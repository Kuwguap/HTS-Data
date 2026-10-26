import type { Metadata } from "next";
import { redirectSignedInOrGetNext } from "@/components/auth/redirect-signed-in";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { loadSettingsSafe } from "@/components/auth/settings-safe";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Create account" };

type SearchParams = Promise<{ next?: string | string[] }>;

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  // Carried over from /login?next=…; validated here, forwarded through /welcome after sign-up.
  const next = await redirectSignedInOrGetNext(sp.next);
  const settings = await loadSettingsSafe();
  // Only whether a hostel code is needed crosses to the client; the code itself never does.
  const requiresCode = Boolean(settings.signup_code?.trim());
  return <RegisterForm requiresCode={requiresCode} hostelName={settings.hostel_name} enquiryPhone={settings.enquiry_phone} next={next} />;
}
