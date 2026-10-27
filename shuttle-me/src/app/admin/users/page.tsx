import { AppHeader } from "@/components/layout/AppHeader";
import { Page } from "@/components/layout/Page";
import { UsersList } from "@/components/admin/UsersList";
import { requirePageAuth } from "@/lib/auth/page";
import { listUsers } from "@/lib/data/admin";

export const dynamic = "force-dynamic";

type Filter = "all" | "student" | "driver" | "admin" | "deactivated";
const FILTERS: Filter[] = ["all", "student", "driver", "admin", "deactivated"];

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; role?: string }> }) {
  const [{ user }, params] = await Promise.all([requirePageAuth({ role: "admin" }), searchParams]);
  const users = await listUsers({ limit: 1000 });
  const filter = FILTERS.includes(params.role as Filter) ? (params.role as Filter) : "all";
  return (
    <Page>
      <AppHeader title="People" greeting={`${users.filter((u) => u.is_active).length} active accounts`} />
      <UsersList users={users} meId={user.id} initialFilter={filter} initialQuery={params.q ?? ""} />
    </Page>
  );
}
