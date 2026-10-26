import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import { loadSettingsSafe } from "@/components/auth/settings-safe";
import { redirectIfSignedIn } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Log in" };

type SearchParams = Promise<{ next?: string | string[]; deactivated?: string | string[] }>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  await redirectIfSignedIn();
  const sp = await searchParams;
  const settings = await loadSettingsSafe();
  const next = first(sp.next);
  return (
    <LoginForm
      next={next && next.startsWith("/") && !next.startsWith("//") ? next : undefined}
      deactivated={first(sp.deactivated) === "1"}
      enquiryPhone={settings.enquiry_phone}
    />
  );
}
