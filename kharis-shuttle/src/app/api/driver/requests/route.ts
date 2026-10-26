import { ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listAcceptedRequestsToday, listPendingPickupRequests } from "@/lib/data/driver";

export const dynamic = "force-dynamic";

/** GET /api/driver/requests — pending pickup requests + the ones accepted/completed today. */
export const GET = withHandler(async () => {
  await requireRole("driver");
  const [pending, accepted] = await Promise.all([listPendingPickupRequests(), listAcceptedRequestsToday()]);
  return ok({ pending, accepted });
});
