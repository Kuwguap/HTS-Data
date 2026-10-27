import { Page } from "@/components/layout/Page";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Instant fallback for every /app/* page: shown the moment a tab is tapped while
 * the page's server payload streams in. The student shell (banner + tab bar in
 * layout.tsx) stays mounted around it.
 */
export default function StudentLoading() {
  return (
    <Page>
      <PageSkeleton />
    </Page>
  );
}
