/**
 * Prompt 26: small Android phone (360×740) layout audit, kept as a regression test.
 * For every main page: no horizontal scroll, every control's effective touch target
 * is at least 24×24 CSS px (WCAG 2.2 SC 2.5.8; inline text links are exempt), and no
 * visible text is smaller than 12px.
 */
import { type Page, expect, test } from "@playwright/test";

test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

const USER_PAGES = [
  "/dashboard",
  "/search",
  "/categories",
  "/products/10000000-0000-7000-8000-000000000001",
  "/compare",
  "/watchlists",
  "/alerts",
  "/history",
  "/notifications",
  "/billing",
  "/settings/profile",
  "/settings/notifications",
  "/settings/security",
  "/settings/privacy",
];
const ADMIN_PAGES = [
  "/admin",
  "/admin/users",
  "/admin/products",
  "/admin/sources",
  "/admin/jobs",
  "/admin/analytics",
];

async function signIn(page: Page, email: string) {
  await page.goto("/login?next=%2Fdashboard");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Correct-horse-42!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(dashboard|admin)/);
}

async function audit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  return page.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0;
    };
    const smallTargets: string[] = [];
    const selector =
      "button, a[href], input, select, textarea, [role=button], [role=tab], [role=checkbox], [role=switch], [role=combobox]";
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!visible(el) || el.closest(".sr-only")) continue;
      const style = getComputedStyle(el);
      if (el.getAttribute("aria-hidden") === "true" || style.pointerEvents === "none") continue;
      if (el.tagName === "A" && style.display === "inline") continue; // links within text
      const box = el.getBoundingClientRect();
      if (box.width >= 24 && box.height >= 24) continue;
      // Smaller than 24px: check the effective hit area (e.g. an enlarged ::after).
      el.scrollIntoView({ block: "center", inline: "center" });
      const v = el.getBoundingClientRect();
      const cx = v.left + v.width / 2;
      const cy = v.top + v.height / 2;
      const offsets: [number, number][] = [
        [11.5, 0],
        [-11.5, 0],
        [0, 11.5],
        [0, -11.5],
      ];
      const ok = offsets.every(([dx, dy]) => {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        return !!hit && (hit === el || el.contains(hit));
      });
      if (!ok) {
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
        smallTargets.push(
          `${el.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    const tinyText: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const p = t.parentElement;
      if (!p || !t.textContent?.trim() || !visible(p) || p.closest(".sr-only")) continue;
      const size = parseFloat(getComputedStyle(p).fontSize);
      if (size < 12) tinyText.push(`${size}px "${t.textContent.trim().slice(0, 30)}"`);
    }
    return { overflow, smallTargets: [...new Set(smallTargets)], tinyText: [...new Set(tinyText)] };
  });
}

for (const [label, email, pages] of [
  ["user", "asha@example.com", USER_PAGES],
  ["admin", "admin@example.com", ADMIN_PAGES],
] as const) {
  test(`360px: ${label} pages fit, have touch-sized targets and readable text`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "mobile", "one run is enough: the viewport is fixed here");
    test.setTimeout(120_000);
    await signIn(page, email);
    for (const path of pages) {
      const r = await audit(page, path);
      expect.soft(r.overflow, `${path}: horizontal overflow`).toBeLessThanOrEqual(1);
      expect.soft(r.smallTargets, `${path}: touch targets under 24×24`).toEqual([]);
      expect.soft(r.tinyText, `${path}: text under 12px`).toEqual([]);
    }
  });
}

test("360px search: the input keeps its width and filters start closed", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  await signIn(page, "asha@example.com");
  await page.goto("/search");
  const input = page.getByLabel("Describe what you want to buy");
  await expect(input).toBeVisible();
  const width = (await input.boundingBox())?.width ?? 0;
  expect(width).toBeGreaterThanOrEqual(180);
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  // Filters are closed by default on phones and open from the filter button.
  const toggle = page.getByRole("button", { name: /show filters/i });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel("Max price (₹)")).toBeHidden();
  await toggle.click();
  await expect(page.getByLabel("Max price (₹)")).toBeVisible();
  await expect(page.getByRole("button", { name: /hide filters/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
