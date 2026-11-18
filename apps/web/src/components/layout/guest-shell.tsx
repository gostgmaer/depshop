import Link from "next/link";
import type { ReactNode } from "react";
import { MobileTabBar } from "@/components/navigation/mobile-tab-bar";
import { Logo } from "@/components/navigation/sidebar-nav";
import { Button } from "@/components/ui/button";
import { ViewerProvider } from "@/lib/viewer";

const GUEST_LINKS = [
  { href: "/search", label: "Search" },
  { href: "/deals", label: "Deals" },
  { href: "/categories", label: "Categories" },
  { href: "/compare", label: "Compare" },
];

/**
 * Chrome for visitors without an account on the public shopping pages (search,
 * results, products, categories, compare, deals). No account data is fetched here.
 */
export function GuestShell({ children }: { children: ReactNode }) {
  return (
    <ViewerProvider guest>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Logo href="/" />
          <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
            {GUEST_LINKS.map((l) => (
              <Button key={l.href} variant="ghost" size="sm" asChild>
                <Link href={l.href}>{l.label}</Link>
              </Button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" asChild>
              <Link href="/register">Create account</Link>
            </Button>
          </div>
        </header>
        <main
          id="main"
          className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-6 px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 lg:py-8"
        >
          {children}
        </main>
        <MobileTabBar variant="guest" />
      </div>
    </ViewerProvider>
  );
}
