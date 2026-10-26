import { expect, test } from "@playwright/test";

/**
 * Smoke tests against `next dev` with placeholder Supabase env (no database):
 * public pages render with defaults, guarded pages redirect, APIs reject
 * anonymous callers, and the PWA plumbing (manifest, service worker) is served
 * correctly. The config runs every test under "desktop" and "iphone".
 *
 * `next dev` does a full reload whenever a server file changes on disk, which
 * can land between an action and its assertion; retries absorb that.
 */

test.describe.configure({ retries: 2 });

test.describe("public pages", () => {
  test("landing shows the hostel name and the app button", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Kharis Courts Hostel");
    await expect(page.getByRole("link", { name: /open the app/i })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: /create account/i })).toHaveAttribute("href", "/register");
    await expect(page.getByRole("link", { name: /install on iphone/i })).toHaveAttribute("href", "/install");
    await expect(page.getByText(/cash only/i).first()).toBeVisible();
  });

  test("/login renders the username and PIN fields", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("PIN", { exact: true })).toBeVisible();
    await expect(page.getByLabel("PIN", { exact: true })).toHaveAttribute("inputmode", "numeric");
    await expect(page.getByRole("button", { name: /log in/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /create account/i })).toHaveAttribute("href", "/register");
  });

  test("/login shows the deactivated notice", async ({ page }) => {
    await page.goto("/login?deactivated=1");
    await expect(page.getByText(/deactivated/i)).toBeVisible();
  });

  test("/register renders the sign-up form", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByLabel("Full name")).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("PIN", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Confirm PIN")).toBeVisible();
    await expect(page.getByRole("button", { name: /create my account/i })).toBeVisible();
    // Username is lowercased as you type.
    await page.getByLabel("Username").fill("AmaMensah");
    await expect(page.getByLabel("Username")).toHaveValue("amamensah");
  });

  test("/install renders", async ({ page }) => {
    await page.goto("/install");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Install the app");
  });
});

test.describe("PWA plumbing", () => {
  test("manifest is standalone", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const manifest = (await res.json()) as { display?: string; start_url?: string; name?: string };
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/app");
    expect(manifest.name).toBeTruthy();
  });

  test("service worker is served uncached", async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain("javascript");
    expect(res.headers()["cache-control"]).toContain("no-cache");
  });
});

test.describe("API guards", () => {
  test("GET /api/me without a session is 401 JSON", async ({ request }) => {
    const res = await request.get("/api/me");
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  test("PATCH /api/me without a session is 401", async ({ request }) => {
    const res = await request.patch("/api/me", { data: { room: "B12" } });
    expect(res.status()).toBe(401);
  });

  test("POST /api/cron/tick without the bearer is 401", async ({ request }) => {
    const res = await request.post("/api/cron/tick");
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  test("POST /api/cron/tick with a wrong bearer is 401", async ({ request }) => {
    const res = await request.post("/api/cron/tick", { headers: { Authorization: "Bearer nope" } });
    expect(res.status()).toBe(401);
  });
});

test.describe("guarded pages", () => {
  test("/welcome redirects to /login when signed out", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel("Username")).toBeVisible();
  });

  test("/app/settings redirects to /login when signed out", async ({ page }) => {
    await page.goto("/app/settings");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("iPhone", () => {
  test.skip(({ isMobile }) => !isMobile, "iPhone project only");

  test("/install shows the Share → Add to Home Screen steps", async ({ page }) => {
    await page.goto("/install");
    await expect(page.getByText(/tap the share button/i)).toBeVisible();
    await expect(page.getByText(/add to home screen/i).first()).toBeVisible();
    await expect(page.getByText(/open .* from your home screen/i)).toBeVisible();
  });

  test("/welcome redirects to /login when signed out (iPhone)", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page).toHaveURL(/\/login/);
  });
});
