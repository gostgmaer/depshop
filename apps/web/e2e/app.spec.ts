import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

async function signIn(page: Page, next = "/dashboard") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill("asha@example.com");
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`**${next}`);
}

test("3. protected pages redirect signed-out visitors to login and back", async ({ page }) => {
  await page.goto("/alerts");
  await expect(page).toHaveURL(/\/login\?next=%2Falerts/);
  await signIn(page, "/alerts");
  await expect(page.getByRole("heading", { name: "Price alerts", level: 1 })).toBeVisible();
});

test("1. dashboard renders real (mock-API) data with honest empty states", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Asha");
  await expect(page.getByText("1 of 2 marketplaces searchable")).toBeVisible();
  await expect(page.getByText("Affiliate API token not configured")).toBeVisible();
  await expect(page.getByText("Not available yet")).toBeVisible(); // trending: never invented
});

test("2/12. navigation works on desktop sidebar and mobile sheet", async ({ page, isMobile }) => {
  await signIn(page);
  if (isMobile) {
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Price Alerts" })
    .click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole("heading", { name: "Price alerts", level: 1 })).toBeVisible();
  // No horizontal page scroll at this viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("4/6/7. search: submit, live marketplace progress (one fails), results", async ({ page }) => {
  await signIn(page, "/search");
  await page
    .getByLabel("Describe what you want to buy")
    .fill("Find a smartphone under ₹35,000 with 8GB RAM");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.waitForURL(/\/search\/[0-9a-f-]+$/);
  const status = page.getByRole("list", { name: "Marketplace status" });
  await expect(status.getByText("Mock Store 1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/results from the others are still shown/)).toBeVisible({
    timeout: 15_000,
  });
  // Final results despite the failed marketplace.
  await expect(page.getByRole("heading", { name: "Acme Nova 7 5G" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("16.66% off MRP").first()).toBeVisible();
  await expect(page.getByText("conditional · not guaranteed").first()).toBeVisible();
  await expect(page.getByLabel("AI summary")).toContainText("Top pick");
});

test("8. product page compares marketplaces by delivered price", async ({ page }) => {
  await signIn(page, "/products/10000000-0000-7000-8000-000000000001");
  await expect(page.getByRole("heading", { name: "Acme Nova 7 5G", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Current best offer")).toContainText("₹24,539");
  await expect(page.getByText("Lowest delivered").first()).toBeVisible();
  await expect(page.getByText("No price history yet")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`13. accessibility basics, ${scheme} mode (axe: no serious or critical violations)`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    const paths = [
      "/dashboard",
      "/search",
      "/products/10000000-0000-7000-8000-000000000001",
      "/alerts",
      "/watchlists",
      "/history",
      "/notifications",
      "/categories",
      "/compare",
    ];
    const found: string[] = [];
    for (const path of paths) {
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
