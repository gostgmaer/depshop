import type { MetadataRoute } from "next";
import { PRIVATE_PATH_PREFIXES, indexingEnabled, siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic"; // reads SEO_INDEXING / SITE_URL at request time

export default function robots(): MetadataRoute.Robots {
  if (!indexingEnabled()) {
    // Default for every environment until launch: crawl nothing.
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const origin = siteUrl() as URL;
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PATH_PREFIXES] },
    sitemap: new URL("/sitemap.xml", origin).toString(),
    host: origin.host,
  };
}
