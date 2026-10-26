import { ApiError, ok, withHandler, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth/require";
import { getTripForStudent } from "@/lib/data/student";
import { uuid } from "@/lib/validation/common";

export const dynamic = "force-dynamic";

/** GET /api/trips/[id] — one trip with my booking (`my_booking`) joined. */
export const GET = withHandler<RouteCtx<{ id: string }>>(async (_request, ctx) => {
  const { user } = await requireUser();
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  const trip = await getTripForStudent(id, user.id);
  if (!trip) throw new ApiError(404, "NOT_FOUND", "Trip not found.");
  return ok({ trip });
});
