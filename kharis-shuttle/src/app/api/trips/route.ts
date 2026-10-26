import { ok, withHandler } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { getSettings } from "@/lib/data/settings";
import { listTripsForStudent } from "@/lib/data/student";

export const dynamic = "force-dynamic";

/** GET /api/trips — today's (and bookable upcoming) trips with my booking joined. */
export const GET = withHandler(async () => {
  const { user } = await requireUser();
  const settings = await getSettings();
  const trips = await listTripsForStudent(user.id, { days: settings.booking_open_days_ahead });
  return ok({ trips });
});
