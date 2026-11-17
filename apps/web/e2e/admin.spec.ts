/** Phase 6.3: admin console access, navigation, responsiveness and accessibility (mock API). */
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

async function signInAs(page: Page, email: string, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
}

const ADMIN_PAGES = [
  "/admin",
  "/admin/users",
  "/admin/users/60000000-0000-7000-8000-000000000002",
  "/admin/products",
  "/admin/categories",
  "/admin/sources",
  "/admin/ai-models",
  "/admin/analytics",
  "/admin/subscriptions",
  "/admin/affiliates",
  "/admin/jobs",
  "/admin/system",
  "/admin/audit-logs",
  "/admin/settings",
];

test("1–2. a regular user can't open the admin console", async ({ page }) => {
  await signInAs(page, "asha@example.com", "/dashboard");
  await page.waitForURL("**/dashboard");
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("Platform dashboard")).toHaveCount(0);
});

test("an admin sees real-labelled figures and navigates the console", async ({
  page,
  isMobile,
}) => {
  await signInAs(page, "admin@example.com", "/admin");
  await page.waitForURL("**/admin");
  await expect(page.getByRole("heading", { name: "Platform dashboard" })).toBeVisible();
  await expect(page.getByText(/Estimate from list prices/)).toBeVisible();
  if (isMobile) await page.getByRole("button", { name: "Open admin navigation" }).click();
  await page
    .getByRole("navigation", { name: "Admin" })
    .getByRole("link", { name: "Connectors" })
    .click();
  await page.waitForURL("**/admin/sources");
  await expect(page.getByRole("heading", { name: "Mock Store" })).toBeVisible();
});

test("admin pages fit the viewport (no horizontal page scroll)", async ({ page }) => {
  await signInAs(page, "admin@example.com", "/admin");
  await page.waitForURL("**/admin");
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`admin accessibility, ${scheme} mode (axe: no serious or critical violations)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signInAs(page, "admin@example.com", "/admin");
    await page.waitForURL("**/admin");
    const found: string[] = [];
    for (const path of ADMIN_PAGES) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const v of results.violations) {
        if (v.impact === "serious" || v.impact === "critical")
          found.push(`${path}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      }
    }
    expect(found).toEqual([]);
  });
}
