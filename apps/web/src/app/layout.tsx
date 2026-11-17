import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "DealMind AI", template: "%s · DealMind AI" },
  description: "Compare prices across Indian shopping sites and find genuine deals.",
};

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
