// TEMPORARY landing so the dev server boots (agent B). The public landing with
// today's departure times and the "Open app" button is built by another agent
// and replaces this file entirely.
import Link from "next/link";
import { Page } from "@/components/layout/Page";
import { Art } from "@/components/ui/Art";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";

export default function LandingPage() {
  return (
    <Page noTabs>
      <div className="k-empty" style={{ paddingTop: 80 }}>
        <Art k="bus" size={72} />
        <h1 className="k-title">{APP_NAME}</h1>
        <p className="k-empty-hint" style={{ maxWidth: 320 }}>
          {APP_DESCRIPTION}
        </p>
        <Link href="/login" className="k-btn k-btn--big" style={{ marginTop: 16, maxWidth: 280 }}>
          🚌 Open app
        </Link>
        <Link href="/install" className="k-link">
          How to install on iPhone
        </Link>
      </div>
    </Page>
  );
}
