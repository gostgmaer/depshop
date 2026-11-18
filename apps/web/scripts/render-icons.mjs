/**
 * Renders the PWA PNG icons from public/icon.svg with Playwright's Chromium
 * (already a dev dependency; no image library needed).
 *
 *   node scripts/render-icons.mjs
 *
 * Outputs public/icons/:
 *   icon-192.png, icon-512.png       "any" purpose (the rounded tile as drawn)
 *   maskable-512.png                  "maskable": full-bleed background, glyph inside the 80 % safe zone
 *   apple-touch-icon.png (180)        iOS home screen (full-bleed; iOS applies its own mask)
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public/icon.svg"), "utf8");
const glyph = /<path[^>]*\/>/.exec(svg)?.[0];
const fill = /<rect[^>]*fill="([^"]+)"/.exec(svg)?.[1];
if (!glyph || !fill) throw new Error("icon.svg: expected a <rect fill> and a <path>");

// Full-bleed square; the glyph (drawn in a 96-unit box) scaled to `scale` and centred.
const fullBleed = (scale) => {
  const offset = (96 - 96 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${fill}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${glyph}</g></svg>`;
};

const outputs = [
  { file: "icon-192.png", size: 192, svg },
  { file: "icon-512.png", size: 512, svg },
  { file: "maskable-512.png", size: 512, svg: fullBleed(0.7) },
  { file: "apple-touch-icon.png", size: 180, svg: fullBleed(0.85) },
];

const outDir = join(root, "public/icons");
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const o of outputs) {
    const page = await browser.newPage({ viewport: { width: o.size, height: o.size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${o.svg.replace("<svg ", `<svg width="${o.size}" height="${o.size}" `)}</body></html>`,
    );
    await page.screenshot({ path: join(outDir, o.file), omitBackground: true });
    await page.close();
    console.log(`public/icons/${o.file} (${o.size}×${o.size})`);
  }
} finally {
  await browser.close();
}
