/** Prompt 25 Stage 4: first-time introduction in a real browser (mock API). */
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** Each test signs in as its own first-time user (isolated state in the mock API). */
async function signInNewUser(page: Page) {
  const id = Math.random().toString(36).slice(2, 10);
  await page.goto("/login?next=%2Fdashboard");
  await page.getByLabel("Email").fill(`new-${id}@example.com`);
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard");
}

test("a first-time user sees the introduction without it blocking search", async ({ page }) => {
  await signInNewUser(page);
  await expect(page.getByText(/getting started · step 1 of 5/i)).toBeVisible();
  // The search box stays usable while the introduction is open.
  const box = page.getByLabel("Describe what you want to buy");
  await expect(box).toBeEditable();
  await box.fill("Find a phone under ₹20,000");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();

  const results = await new AxeBuilder({ page })
    .include("section[aria-labelledby='onboarding-title']")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
});

test("skipping closes it for good (survives a reload)", async ({ page }) => {
  await signInNewUser(page);
  await page.getByRole("button", { name: "Skip introduction" }).click();
  await expect(page.getByText(/getting started/i)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/getting started/i)).toHaveCount(0);
});

test("finishing it, then reopening from Settings", async ({ page }) => {
  await signInNewUser(page);
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/getting started/i)).toHaveCount(0);

  await page.goto("/settings/profile");
  await page.getByRole("link", { name: "Show the introduction again" }).click();
  await expect(page.getByText(/step 1 of 5/i)).toBeVisible();
});

test("an existing user who completed it never sees it", async ({ page }) => {
  await page.goto("/login?next=%2Fdashboard");
  await page.getByLabel("Email").fill("asha@example.com");
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/getting started/i)).toHaveCount(0);
});
