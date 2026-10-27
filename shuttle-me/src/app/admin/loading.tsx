import { Page } from "@/components/layout/Page";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** Instant fallback for every /admin/* page while its server payload streams in; the tab bar stays mounted. */
export default function AdminLoading() {
  return (
    <Page>
      <PageSkeleton />
    </Page>
  );
}
