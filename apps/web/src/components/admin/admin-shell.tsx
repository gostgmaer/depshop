"use client";

import type { PublicUser } from "@dealmind/shared";
import { ArrowLeft, Menu, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/primitives";
import { useMe } from "@/lib/auth-hooks";
import { cn } from "@/lib/utils";
import { ADMIN_NAV, isAdminActive } from "./admin-nav";

function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex flex-col gap-5">
      {ADMIN_NAV.map((section) => (
        <div key={section.label} className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {section.label}
          </p>
          {section.items.map((item) => {
            const active = isAdminActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground outline-none transition-colors",
                  "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                  active && "bg-muted font-medium text-foreground",
                )}
              >
                <Icon aria-hidden className={cn("size-4", active && "text-primary")} />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function AdminLogo() {
  return (
    <Link
      href="/admin"
      className="flex items-center gap-2 rounded-lg px-3 font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <ShieldCheck aria-hidden className="size-5 text-primary" />
      <span>DealMind Admin</span>
    </Link>
  );
}

/** Admin chrome: separate navigation from the shopper app; same session. */
export function AdminShell({ user, children }: { user: PublicUser; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe(user);
  useEffect(() => {
    // Session ended, or the admin role was removed: leave the admin area.
    if (me.data === null) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (me.data && me.data.role !== "ADMIN") router.replace("/dashboard");
  }, [me.data, router, pathname]);
  const current = me.data ?? user;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r border-border bg-surface px-3 py-5 lg:flex">
        <AdminLogo />
        <AdminNav />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open admin navigation"
              >
                <Menu aria-hidden className="size-5" />
              </Button>
            </DialogTrigger>
            <DialogContent side="left" title="Admin navigation">
              <AdminNav onNavigate={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
          <span className="lg:hidden">
            <AdminLogo />
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground md:inline">
              {current.email}
            </span>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard">
                <ArrowLeft aria-hidden className="size-4" />
                <span className="hidden sm:inline">Back to app</span>
                <span className="sm:hidden">App</span>
              </Link>
            </Button>
          </div>
        </header>
        <main
          id="main"
          className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
