import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, the service worker, icons and metadata files.
    "/((?!_next/static|_next/image|sw\\.js|icons/|manifest\\.webmanifest|favicon\\.ico|apple-icon|icon\\.png|robots\\.txt).*)",
  ],
};
