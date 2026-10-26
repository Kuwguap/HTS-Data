import { ok, withHandler } from "@/lib/api";
import { signOutCurrent } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** POST /api/auth/logout — clears the cookie session. */
export const POST = withHandler(async () => {
  await signOutCurrent();
  return ok({ ok: true });
});
