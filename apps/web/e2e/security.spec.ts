/** Phase 7.1: web security headers, CSP without violations, and proxy path confinement (production build). */
import { expect, test } from "@playwright/test";

test("pages send CSP (nonce, no framing) and hardening headers", async ({ page }) => {
  const res = await page.goto("/login");
  const h = res!.headers();
  const csp = h["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain("unsafe-eval");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["x-powered-by"]).toBeUndefined();
  // Each request gets a fresh nonce.
  const again = (await page.goto("/login"))!.headers()["content-security-policy"];
  expect(again).not.toBe(csp);
});

test("the app runs under the CSP (no violations while signing in and searching)", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text()))
      violations.push(m.text());
  });
  await page.goto("/login?next=%2Fdashboard");
  await page.getByLabel("Email").fill("asha@example.com");
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard");
  await page.goto("/search");
  await page.waitForLoadState("networkidle");
  await page.goto("/products/10000000-0000-7000-8000-000000000001");
  await page.waitForLoadState("networkidle");
  expect(violations).toEqual([]);
});

test("the API proxy can't be steered outside /api", async ({ request }) => {
  for (const path of [
    "/api/%2e%2e/internal/v1/categories",
    "/api/v1/%2e%2e/%2e%2e/internal/v1/categories",
    "/api/%2e%2e/webhooks/easydev-payments",
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    // Our own refusal, not the API's (the API would answer "E2E mock has no …").
    expect(await res.text(), path).not.toContain("E2E mock");
  }
});
