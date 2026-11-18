import type { MetadataRoute } from "next";
import { INDEXABLE_PATHS, indexingEnabled, siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

/**
 * Only pages that are public and useful today. Product, category and deal pages
 * are signed-in pages and are not listed; public discovery pages will be added
 * only for catalog entries that pass the indexability policy in
 * docs/programmatic-seo.md. No `lastModified` is given: an invented date is worse
 * than none.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!indexingEnabled()) return [];
  const origin = siteUrl() as URL;
  return INDEXABLE_PATHS.map((path) => ({ url: new URL(path, origin).toString() }));
}
