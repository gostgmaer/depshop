import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline", robots: { index: false, follow: false } };

/**
 * Shown by the service worker when a page can't be loaded because the device is
 * offline (docs/offline-experience.md). Cached once at service-worker install;
 * it contains no user data. Works without JavaScript: "Try again" is a plain link.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-6 py-12">
      <p className="rounded-full border border-warning/30 bg-warning-soft px-3 py-1 text-xs font-medium text-warning">
        No connection
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">You're offline</h1>
      <p className="text-muted-foreground">
        DealMind needs a connection to search marketplaces and show current prices. Nothing you see
        while offline is a live price.
      </p>
      <p className="text-muted-foreground">
        Your watchlists and alerts are kept on our servers and price checks keep running. Alerts
        still reach you by e-mail or push if you turned those on, and in the app when you're back.
      </p>
      <a
        href="/dashboard"
        className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground"
      >
        Try again
      </a>
    </main>
  );
}
