import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { firstParam, redirectSignedInOrGetNext } from "@/components/auth/redirect-signed-in";
import { loadSettingsSafe } from "@/components/auth/settings-safe";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Log in" };

type SearchParams = Promise<{ next?: string | string[]; deactivated?: string | string[] }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  // Validate `next` first so a signed-in visitor lands where they were headed (same-origin only).
  const next = await redirectSignedInOrGetNext(sp.next);
  const settings = await loadSettingsSafe();
  return <LoginForm next={next} deactivated={firstParam(sp.deactivated) === "1"} enquiryPhone={settings.enquiry_phone} />;
}
