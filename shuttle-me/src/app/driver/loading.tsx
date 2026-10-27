import { Page } from "@/components/layout/Page";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** Instant fallback for every /driver/* page while its server payload streams in; the tab bar stays mounted. */
export default function DriverLoading() {
  return (
    <Page>
      <PageSkeleton />
    </Page>
  );
}
