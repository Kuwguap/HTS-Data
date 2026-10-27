import Link from "next/link";
import type { ReactNode } from "react";
import { Page } from "@/components/layout/Page";
import { Art } from "@/components/ui/Art";
import { APP_NAME } from "@/lib/constants";

/** Centred narrow column for /login and /register: brand on top, the form card under it, no tab bar. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <Page noTabs>
      <div className="flex flex-col items-center" style={{ paddingTop: "max(28px, calc(var(--safe-top) + 20px))", gap: 6 }}>
        <Link href="/" aria-label={`${APP_NAME} home`} style={{ display: "inline-flex" }}>
          <Art k="bus" size={64} />
        </Link>
        <div className="k-title" style={{ fontSize: 24 }}>
          {APP_NAME}
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 400, margin: "0 auto" }} className="flex flex-col gap-3">
        {children}
      </div>
    </Page>
  );
}
