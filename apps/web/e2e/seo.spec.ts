/** Prompt 25: with no SEO_INDEXING (CI, dev, staging), nothing may be indexable. */
import { expect, test } from "@playwright/test";

test("indexing is off by default: robots disallows all, sitemap is empty, pages are noindex", async ({
  page,
  request,
}) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toMatch(/User-Agent: \*\s+Disallow: \/\s*$/);

  const sitemap = await request.get("/sitemap.xml");
  expect(await sitemap.text()).not.toContain("<loc>");

  await page.goto("/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Find genuine deals. Compare prices. Track products. Buy smarter.",
  );
  // No structured data without a configured public origin.
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
});

test("private areas send X-Robots-Tag noindex whatever the indexing switch says", async ({
  request,
}) => {
  for (const path of ["/dashboard", "/admin", "/search", "/settings/privacy", "/reset-password"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
  }
});

test("the homepage makes no coverage or lowest-price guarantees", async ({ page }) => {
  await page.goto("/");
  const text = (await page.locator("main").innerText()).toLowerCase();
  for (const claim of [
    "every store",
    "every marketplace",
    "all marketplaces",
    "guaranteed",
    "lowest real price",
  ]) {
    expect(text).not.toContain(claim);
  }
});
