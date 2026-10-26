import { ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { listTripsForDriver } from "@/lib/data/driver";

export const dynamic = "force-dynamic";

/** GET /api/driver/trips — today's and tomorrow's trips with isMine / unassigned / boarded_count. */
export const GET = withHandler(async () => {
  const { user } = await requireRole("driver");
  const trips = await listTripsForDriver(user.id);
  return ok({ trips });
});
