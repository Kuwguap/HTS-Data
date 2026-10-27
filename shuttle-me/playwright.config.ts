import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 2,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next dev -p ${PORT}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 180_000,
        env: {
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://example.supabase.co",
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_placeholder",
          SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY ?? "sb_secret_placeholder",
          NEXT_PUBLIC_VAPID_PUBLIC_KEY:
            process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
            "BPlaceholderPublicKeyPlaceholderPublicKeyPlaceholderPublicKeyPlaceholderPublicKeyPlaceholder0",
          VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? "placeholder",
          VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? "mailto:test@example.com",
          CRON_SECRET: process.env.CRON_SECRET ?? "test-cron-secret",
          PIN_PEPPER: process.env.PIN_PEPPER ?? "test-pepper",
        },
      },
});
