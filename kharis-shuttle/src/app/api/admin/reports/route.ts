import { NextResponse } from "next/server";
import { ApiError, ok, withHandler } from "@/lib/api";
import { requireRole } from "@/lib/auth/require";
import { defaultReportRange, reportToCsv, reports } from "@/lib/data/admin";
import { getSettings } from "@/lib/data/settings";
import { reportQuerySchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/** GET /api/admin/reports?from&to&format=json|csv — ridership report (reportQuerySchema). */
export const GET = withHandler(async (request) => {
  await requireRole("admin");
  const url = new URL(request.url);
  const parsed = reportQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "Please check the dates.", parsed.error.flatten());

  const settings = await getSettings();
  const def = defaultReportRange(new Date(), settings.timezone);
  const from = parsed.data.from ?? def.from;
  const to = parsed.data.to ?? def.to;
  if (from > to) throw new ApiError(400, "VALIDATION", "'From' must be before 'to'.");

  const report = await reports({ from, to });
  if (parsed.data.format === "csv") {
    return new NextResponse(reportToCsv(report), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="shuttle-report-${from}-to-${to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return ok({ report });
});
