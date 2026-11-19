/** Prompt 26: manifest, service worker, safe caching, offline fallback, mobile navigation. */
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

async function signIn(page: Page, next = "/dashboard") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill("asha@example.com");
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`**${next}`);
}

/** Waits until the service worker is active and controls this page. */
async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))))
    await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

/** Every URL in every cache, as same-origin paths. */
const cachedPaths = (page: Page) =>
  page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  });

/** PNG width/height from the IHDR chunk. */
function pngSize(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("the manifest is valid and its icons exist at the declared sizes", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("manifest+json");
  const m = (await res.json()) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  expect(m).toMatchObject({
    name: "DealMind AI",
    short_name: "DealMind",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
  });
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  for (const icon of m.icons.filter((i) => i.type === "image/png")) {
    const img = await request.get(icon.src);
    expect(img.ok(), icon.src).toBe(true);
    const { width, height } = pngSize(await img.body());
    expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
  }
  // Chrome's installability needs a 192 and a 512 icon, and a maskable one is recommended.
  const sizes = m.icons.map((i) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", m.theme_color);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    /apple-touch-icon\.png/,
  );
});

test("the service worker caches only static assets and the offline page, never private data", async ({
  page,
}) => {
  await signIn(page);
  await controlled(page);
  // Browse private, data-bearing pages so their responses would be cached if anything were.
  for (const path of [
    "/dashboard",
    "/watchlists",
    "/alerts",
    "/notifications",
    "/settings/profile",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  const paths = await cachedPaths(page);
  expect(paths).toContain("/offline");
  expect(paths.some((p) => p.startsWith("/_next/static/"))).toBe(true);
  const allowed = (p: string) =>
    p === "/offline" ||
    p === "/icon.svg" ||
    p.startsWith("/_next/static/") ||
    p.startsWith("/icons/");
  expect(paths.filter((p) => !allowed(p))).toEqual([]);
  expect(paths.some((p) => p.startsWith("/api/"))).toBe(false);
});

test("offline: a page load shows the offline page, and live data is never claimed", async ({
  page,
  context,
}) => {
  await signIn(page);
  await controlled(page);
  await context.setOffline(true);
  await page.goto("/watchlists").catch(() => undefined);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await expect(page.getByText("Nothing you see while offline is a live price.")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("after sign-out, a previously viewed private page is never served from a cache", async ({
  page,
  context,
}) => {
  await signIn(page, "/watchlists");
  await controlled(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login(\?|$)/);

  // Online: the private page needs a session again.
  await page.goto("/watchlists");
  await expect(page).toHaveURL(/\/login/);
  // Offline: the offline page, not the watchlist the previous user saw.
  await context.setOffline(true);
  await page.goto("/watchlists").catch(() => undefined);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await context.setOffline(false);
});

test("private pages tell browsers not to store them", async ({ page }) => {
  await signIn(page);
  const res = await page.goto("/watchlists");
  expect(res?.headers()["cache-control"] ?? "").toMatch(/no-store/);
});

test("mobile bottom navigation: five tabs, current page marked, back button works", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const tabs = page.getByRole("navigation", { name: "Quick navigation" });
  if (testInfo.project.name === "desktop") {
    await expect(tabs).toBeHidden(); // the sidebar is the desktop navigation
    return;
  }
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("link")).toHaveText([
    "Home",
    "Deals",
    "Watchlists",
    "Alerts",
    "Account",
  ]);
  await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("link", { name: "Watchlists" }).click();
  await expect(page).toHaveURL(/\/watchlists$/);
  await expect(tabs.getByRole("link", { name: "Watchlists" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tabs.getByRole("link", { name: "Home" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Touch targets: at least 44×44 CSS px (WCAG 2.5.5 / platform guidance).
  for (const box of await tabs
    .getByRole("link")
    .evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })),
    )) {
    expect(box.w).toBeGreaterThanOrEqual(44);
    expect(box.h).toBeGreaterThanOrEqual(44);
  }
  // The last content on the page is not hidden behind the bar.
  const overlap = await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const bar = document.querySelector('nav[aria-label="Quick navigation"]')!;
    const paddingBottom = parseFloat(getComputedStyle(main).paddingBottom);
    return paddingBottom - bar.getBoundingClientRect().height;
  });
  expect(overlap).toBeGreaterThanOrEqual(0);
});

test("Settings shows how to install the app without prompting on its own", async ({ page }) => {
  await signIn(page, "/settings/profile");
  const card = page
    .getByRole("region", { name: "Install the app" })
    .or(page.locator("section", { hasText: "Install the app" }));
  await expect(card.first()).toBeVisible();
  // No automatic dialog: the page shows instructions or a button, nothing modal.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
