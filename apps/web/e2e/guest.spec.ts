/** No account needed to search, view results and products, and browse deals (mock API). */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("a visitor searches without an account and follows the results", async ({ page }) => {
  // The mock API has live store search on (the production default is deals-only).
  await page.goto("/search");
  // Guest chrome: sign-in offered, no account menu.
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);

  await page
    .getByLabel("Describe what you want to buy")
    .fill("Find a smartphone under ₹30,000 with 8GB RAM");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/\/search\/[0-9a-f-]+$/);
  await expect(page.getByRole("list", { name: "Search progress" })).toBeVisible();
});

test("a visitor can open a product, and tracking asks to sign in", async ({ page }) => {
  await page.goto("/products/10000000-0000-7000-8000-000000000001");
  await expect(page.getByRole("heading", { name: "Acme Nova 7 5G", level: 1 })).toBeVisible();
  const signIn = page.getByRole("link", { name: /Sign in to track this product/ });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", /\/login\?next=%2Fproducts%2F/);
});

test("deals: public, built from stored offers, with source, freshness and sample label", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Explore all deals" }).click();
  await expect(page).toHaveURL(/\/deals$/);
  const deals = page.getByRole("list", { name: "Deals" });
  const card = deals.getByRole("listitem").first();
  await expect(card.getByRole("link", { name: "Acme Nova 7 5G" })).toBeVisible();
  await expect(card).toContainText("₹23,999");
  await expect(card).toContainText("off MRP");
  await expect(card).toContainText("Mock Store 1");
  await expect(card).toContainText("deal at 2 stores");
  await expect(card).toContainText("Price seen");
  await expect(card).toContainText("Sample data");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
});

test("home page: top deals, each opening its product page; the search box searches deals", async ({
  page,
}) => {
  await page.goto("/");
  const top = page.getByRole("list", { name: "Top deals" });
  await expect(top.getByRole("link", { name: "Acme Nova 7 5G" })).toBeVisible();
  await expect(top).toContainText("20% off MRP");
  await expect(top.getByRole("link", { name: "Price history & buy" })).toHaveAttribute(
    "href",
    "/products/10000000-0000-7000-8000-000000000001",
  );

  await page.getByRole("searchbox", { name: "Search deals" }).fill("nova");
  await page.getByRole("button", { name: "Search deals" }).click();
  await expect(page).toHaveURL(/\/deals\?q=nova$/);
  await expect(page.getByRole("heading", { name: /Deals matching “nova”/ })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Deals" }).getByRole("link", { name: "Acme Nova 7 5G" }),
  ).toHaveCount(1);

  await page.goto("/deals?q=refrigerator");
  await expect(page.getByText("No current deals match “refrigerator”")).toBeVisible();
});

test("account features still need an account", async ({ page }) => {
  for (const path of ["/watchlists", "/alerts", "/dashboard", "/settings/profile", "/billing"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login\?next=/);
  }
});
