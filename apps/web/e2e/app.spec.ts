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
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/\/search\/[0-9a-f-]+$/);
  const status = page.getByRole("list", { name: "Marketplace status" });
  await expect(status.getByText("Mock Store 1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/results from the other marketplaces are still shown/)).toBeVisible({
    timeout: 15_000,
  });
  // Final results despite the failed marketplace.
  await expect(page.getByRole("heading", { name: "Acme Nova 7 5G" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("16.66% off MRP").first()).toBeVisible();
  await expect(page.getByText("conditional · not guaranteed").first()).toBeVisible();
  await expect(page.getByLabel("AI summary")).toContainText("Top pick");
});

test("4.2 category filters, live steps, sort, grid and comparison selection", async ({ page }) => {
  await signIn(page, "/search");
  await page.getByLabel("Describe what you want to buy").fill("Find a phone with 8GB RAM");
  // Category-specific filters come from the category's catalog data.
  await page.getByLabel("Category", { exact: true }).selectOption("smartphones");
  await page.getByLabel("RAM", { exact: true }).selectOption("8 GB");
  await page.getByLabel("Minimum verified discount").selectOption("10");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/\/search\/[0-9a-f-]+$/);

  // Real (mock-API) pipeline events drive the steps; the final step waits for the result.
  const steps = page.getByRole("list", { name: "Search progress" });
  await expect(steps.getByText("AI understanding the query")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Partial results" })).toBeVisible({
    timeout: 15_000,
  });
  const marketplaces = page.getByRole("list", { name: "Marketplace status" });
  await expect(marketplaces.getByText(/Credentials unavailable/)).toBeVisible();
  await expect(page.getByText("2 ranked deals")).toBeVisible();

  await page.getByLabel("Sort").selectOption("price_asc");
  await expect(page).toHaveURL(/sort=price_asc/);
  await page.getByRole("button", { name: "Grid" }).click();
  await expect(page).toHaveURL(/view=grid/);

  const boxes = page.getByRole("checkbox", { name: "Compare" });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole("link", { name: /Compare 2/ }).click();
  await expect(page).toHaveURL(/\/compare\?items=/);
  await expect(page.getByRole("heading", { name: "Compare products", level: 1 })).toBeVisible();
  await expect(page.getByText(/different variants of the same product/)).toBeVisible();
  await expect(page.getByText("Different variant").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("4.3 product intelligence: offers, stale toggle, history periods, chart keyboard", async ({
  page,
}) => {
  await signIn(page, "/products/10000000-0000-7000-8000-000000000001");
  await expect(page.getByRole("heading", { name: "Acme Nova 7 5G", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Current best offer")).toContainText("₹24,539");
  await expect(page.getByLabel("Lowest delivered price", { exact: true })).toContainText(
    "Mock Store 2",
  );
  await expect(page.getByText("Lowest delivered").first()).toBeVisible();

  // Stale offers only on request, and never "lowest".
  await page.getByRole("checkbox", { name: "Include offers not seen recently" }).click();
  await expect(page).toHaveURL(/stale=1/);
  await expect(page.getByText("Not current").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByLabel("Current best offer")).toContainText("₹24,539");

  // Periods and marketplace-specific history from stored observations.
  await page.getByRole("button", { name: "7D" }).click();
  await expect(page).toHaveURL(/period=7/);
  await page.getByRole("button", { name: "All" }).click();
  await expect(page.getByText(/so these are not all-time figures/)).toBeVisible();
  await page.getByLabel("Marketplace", { exact: true }).selectOption("mock_1");
  await expect(page).toHaveURL(/src=mock_1/);
  const stats = page.getByRole("region", { name: "Price statistics" });
  await expect(stats).toContainText("Selected marketplace");
  await expect(stats).toContainText("Mock Store 1");

  // The chart is keyboard-operable: arrow keys step through observations.
  const chart = page.getByRole("application", { name: /Price history from/ });
  await expect(chart).toBeVisible();
  await chart.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("status").filter({ hasText: "Mock Store 1" }).first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("4.3 compare page: recommendations, variant warning, add-product picker", async ({
  page,
  isMobile,
}) => {
  await signIn(
    page,
    "/compare?items=10000000-0000-7000-8000-000000000001:20000000-0000-7000-8000-000000000001,10000000-0000-7000-8000-000000000001:20000000-0000-7000-8000-000000000002",
  );
  await expect(
    page.getByRole("heading", { name: "Best deal across these products" }),
  ).toBeVisible();
  await expect(page.getByText(/different variants of the same product/)).toBeVisible();
  if (isMobile) {
    await expect(page.getByRole("list", { name: "Compared products" })).toBeVisible();
  } else {
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Acme Nova 7 5G/ }).first()).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Add a product" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
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
      "/settings/notifications",
      "/unsubscribe?token=sample",
      "/categories",
      "/compare",
      "/search/40000000-0000-7000-8000-000000000001",
      "/products/10000000-0000-7000-8000-000000000001?stale=1&period=all&src=mock_1&mrp=1",
      "/compare?items=10000000-0000-7000-8000-000000000001:20000000-0000-7000-8000-000000000001,10000000-0000-7000-8000-000000000001:20000000-0000-7000-8000-000000000002",
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
