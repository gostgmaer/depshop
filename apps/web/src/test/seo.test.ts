/** Prompt 25 Stage 2: technical SEO policy (docs/seo-architecture.md). */
import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { generateMetadata } from "@/app/layout";
import {
  INDEXABLE_PATHS,
  PRIVATE_PATH_PREFIXES,
  indexingEnabled,
  isPrivatePath,
  jsonLdString,
  siteJsonLd,
  siteUrl,
} from "@/lib/seo";

const ON = { SEO_INDEXING: "enabled", SITE_URL: "https://dealmind.example" };

afterEach(() => vi.unstubAllEnvs());

function setEnv(env: Record<string, string | undefined>) {
  vi.stubEnv("SEO_INDEXING", env.SEO_INDEXING ?? "");
  vi.stubEnv("SITE_URL", env.SITE_URL ?? "");
}

describe("indexing switch", () => {
  it("is off by default and needs both the flag and a valid https origin", () => {
    expect(indexingEnabled({})).toBe(false);
    expect(indexingEnabled({ SEO_INDEXING: "enabled" })).toBe(false);
    expect(indexingEnabled({ SITE_URL: ON.SITE_URL })).toBe(false);
    expect(indexingEnabled({ ...ON, SEO_INDEXING: "true" })).toBe(false);
    expect(indexingEnabled(ON)).toBe(true);
  });

  it("rejects non-https, paths, queries and garbage as the site origin", () => {
    for (const bad of [
      "http://dealmind.example",
      "https://dealmind.example/app",
      "https://dealmind.example/?x=1",
      "dealmind.example",
      "javascript:alert(1)",
    ]) {
      expect(siteUrl({ SITE_URL: bad }), bad).toBeNull();
    }
    expect(siteUrl({ SITE_URL: "http://localhost:3000" })?.host).toBe("localhost:3000");
  });
});

describe("robots.txt", () => {
  it("disallows everything unless indexing is enabled", () => {
    setEnv({});
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    setEnv({ SITE_URL: ON.SITE_URL }); // origin alone is not enough
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
  });

  it("when enabled, blocks every private area and points at the sitemap", () => {
    setEnv(ON);
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rules?.allow).toBe("/");
    for (const p of [
      "/admin",
      "/dashboard",
      "/search",
      "/watchlists",
      "/alerts",
      "/settings",
      "/api/",
    ]) {
      expect(rules?.disallow).toContain(p);
    }
    expect(r.sitemap).toBe("https://dealmind.example/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  it("is empty unless indexing is enabled", () => {
    setEnv({});
    expect(sitemap()).toEqual([]);
  });

  it("lists only public pages, absolute, without invented dates", () => {
    setEnv(ON);
    const urls = sitemap();
    expect(urls.map((u) => u.url)).toEqual([
      "https://dealmind.example/",
      "https://dealmind.example/pricing",
      "https://dealmind.example/privacy",
    ]);
    expect(urls.every((u) => u.lastModified === undefined)).toBe(true);
    for (const u of urls) expect(isPrivatePath(new URL(u.url).pathname)).toBe(false);
  });
});

describe("private paths", () => {
  it("covers user data, admin, auth and one-time-link pages", () => {
    for (const p of [
      "/admin",
      "/admin/users/1",
      "/dashboard",
      "/search/abc",
      "/watchlists/1",
      "/alerts",
      "/history",
      "/settings/privacy",
      "/login",
      "/reset-password",
      "/unsubscribe",
      "/products/123",
      "/api/v1/users/me",
    ]) {
      expect(isPrivatePath(p), p).toBe(true);
    }
  });

  it("never treats a public page as private, and no public page is in the private list", () => {
    for (const p of INDEXABLE_PATHS) expect(isPrivatePath(p), p).toBe(false);
    expect(isPrivatePath("/pricing-guide")).toBe(false); // prefix match is per path segment
    expect(isPrivatePath("/searchlight")).toBe(false);
    expect(PRIVATE_PATH_PREFIXES.length).toBeGreaterThan(10);
  });
});

describe("site metadata", () => {
  it("is noindex/nofollow everywhere while indexing is off", () => {
    setEnv({});
    const m = generateMetadata();
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.metadataBase).toBeUndefined();
  });

  it("sets the canonical base and Open Graph when enabled, without a site-wide noindex", () => {
    setEnv(ON);
    const m = generateMetadata();
    expect(m.robots).toBeUndefined();
    expect(String(m.metadataBase)).toBe("https://dealmind.example/");
    expect(m.openGraph).toMatchObject({
      siteName: "DealMind AI",
      locale: "en_IN",
      type: "website",
    });
  });

  it("never claims complete coverage or guaranteed lowest prices", () => {
    setEnv(ON);
    const text = JSON.stringify(generateMetadata()).toLowerCase();
    for (const claim of [
      "every store",
      "all marketplaces",
      "guaranteed",
      "lowest price guaranteed",
    ]) {
      expect(text).not.toContain(claim);
    }
  });
});

describe("structured data", () => {
  it("is valid schema.org JSON with only facts: no ratings, offers, prices or search action", () => {
    const blocks = siteJsonLd(new URL(ON.SITE_URL));
    const types = blocks.map((b) => b["@type"]);
    expect(types).toEqual(["WebSite", "Organization"]);
    for (const b of blocks) {
      const parsed = JSON.parse(jsonLdString(b)) as Record<string, unknown>;
      expect(parsed["@context"]).toBe("https://schema.org");
      expect(parsed.url).toBe("https://dealmind.example/");
      for (const k of ["aggregateRating", "review", "offers", "potentialAction", "logo"]) {
        expect(parsed).not.toHaveProperty(k);
      }
    }
  });

  it("escapes '<' so the data can never close its script element", () => {
    const s = jsonLdString({ name: "</script><script>alert(1)</script>" });
    expect(s).not.toContain("<");
    expect(JSON.parse(s)).toEqual({ name: "</script><script>alert(1)</script>" });
  });
});
