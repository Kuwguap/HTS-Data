import { ok } from "@/lib/api";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

/** GET /api/health → { ok, version, time }. Used by uptime checks and the Playwright web server probe. */
export async function GET() {
  return ok(
    {
      ok: true,
      version: pkg.version,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
