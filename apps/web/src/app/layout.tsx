import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { indexingEnabled, siteUrl } from "@/lib/seo";
import { THEME_COLOR } from "./manifest";
import { Providers } from "./providers";

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  // Content extends under the notch / home indicator; padding uses env(safe-area-inset-*).
  viewportFit: "cover",
};

const DESCRIPTION =
  "Compare prices across the Indian shopping sites DealMind is connected to, check whether a discount is genuine, and track prices.";

export function generateMetadata(): Metadata {
  const origin = siteUrl();
  return {
    ...(origin ? { metadataBase: origin } : {}),
    title: { default: "DealMind AI", template: "%s · DealMind AI" },
    description: DESCRIPTION,
    applicationName: "DealMind AI",
    // iOS home-screen launch (Safari ignores most of the manifest).
    appleWebApp: { capable: true, title: "DealMind", statusBarStyle: "default" },
    icons: {
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
    },
    openGraph: {
      type: "website",
      siteName: "DealMind AI",
      locale: "en_IN",
      title: "DealMind AI",
      description: DESCRIPTION,
    },
    twitter: { card: "summary", title: "DealMind AI", description: DESCRIPTION },
    // Until indexing is deliberately enabled (SEO_INDEXING=enabled + SITE_URL), no page is indexable.
    ...(indexingEnabled() ? {} : { robots: { index: false, follow: false } }),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the per-request CSP nonce (set by middleware) keeps every page
  // dynamically rendered, so Next.js can apply the nonce to its scripts.
  await headers();
  return (
    <html lang="en-IN">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
