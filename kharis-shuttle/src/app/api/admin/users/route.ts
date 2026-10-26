import { ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listUsers, type UserFilter } from "@/lib/data/admin";

export const dynamic = "force-dynamic";

const FILTERS: UserFilter[] = ["all", "student", "driver", "admin", "deactivated"];

/** GET /api/admin/users?q=&role=student|driver|admin|deactivated — search people. */
export const GET = withHandler(async (request) => {
  await requireRole("admin");
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  const roleParam = url.searchParams.get("role") ?? "all";
  const role = FILTERS.includes(roleParam as UserFilter) ? (roleParam as UserFilter) : "all";
  const users = await listUsers({ q, role, limit: 500 });
  return ok({ users });
});
