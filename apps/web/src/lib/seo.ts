/**
 * Search-engine policy for the public site (docs/seo-architecture.md).
 *
 * Indexing is OFF unless explicitly enabled: `SEO_INDEXING=enabled` and a valid
 * `SITE_URL`. Every other environment (dev, CI, the rehearsal stack, staging, and
 * production before launch) serves "Disallow: /" and `noindex`, so nothing is
 * indexed by accident.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Public pages that may be indexed (and listed in the sitemap) when indexing is on. */
export const INDEXABLE_PATHS = ["/", "/pricing", "/privacy"] as const;

/**
 * Never indexed, whatever the switch says: signed-in areas (searches, watchlists,
 * alerts, account), admin, auth flows, one-time links, and the API proxy.
 */
export const PRIVATE_PATH_PREFIXES = [
  "/admin",
  "/dashboard",
  "/search",
  "/products",
  "/categories",
  "/compare",
  // Public, but not indexed until the catalog holds real (non-sample) data (docs/programmatic-seo.md).
  "/deals",
  "/watchlists",
  "/alerts",
  "/notifications",
  "/history",
  "/billing",
  "/settings",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/unsubscribe",
  "/api/",
] as const;

/** The public origin, or null when unset or invalid (then nothing is indexable). */
export function siteUrl(env: Env = process.env): URL | null {
  const raw = env.SITE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    if (u.pathname !== "/" || u.search || u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

export function indexingEnabled(env: Env = process.env): boolean {
  return env.SEO_INDEXING === "enabled" && siteUrl(env) !== null;
}

export function isPrivatePath(pathname: string): boolean {
  return PRIVATE_PATH_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Serialises JSON-LD for an inline <script type="application/ld+json">.
 * "<" is escaped so content can never close the script element.
 */
export function jsonLdString(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Site-level structured data. Deliberately minimal: no SearchAction (search needs
 * an account), no logo claims, no ratings, no offers. Nothing here is invented.
 */
export function siteJsonLd(origin: URL): Record<string, unknown>[] {
  const url = origin.toString();
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "DealMind AI",
      url,
      inLanguage: "en-IN",
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "DealMind AI",
      url,
    },
  ];
}
