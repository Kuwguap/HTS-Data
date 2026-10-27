import type { NextConfig } from "next";

/** Short git commit of this build (Vercel sets VERCEL_GIT_COMMIT_SHA); "dev" elsewhere. Compared with /api/health by BuildRefresh. */
const buildCommit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_COMMIT: buildCommit },
  // Playwright and curl talk to the dev server via 127.0.0.1; Next 16 treats that
  // as a cross-origin dev host unless listed here.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(self), camera=(), microphone=()",
          },
        ],
      },
      {
        // The service worker must never be cached so new deploys reach phones.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/icons/(.*)",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800, immutable" }],
      },
    ];
  },
};

export default nextConfig;
