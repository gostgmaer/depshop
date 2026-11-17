"use client";

import type { PublicUser } from "@dealmind/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, LogOut, Menu, Settings, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Logo, SidebarNav } from "@/components/navigation/sidebar-nav";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/primitives";
import { useUnreadCount } from "@/hooks/queries";
import { useNotificationStream } from "@/hooks/use-notification-stream";
import { ME_KEY, subscribeAuthChanges, useLogout, useMe } from "@/lib/auth-hooks";

/**
 * Authenticated application chrome: sidebar (desktop), sheet navigation
 * (mobile), top bar with notifications and the account menu. Keeps the page
 * in sync with the server session: when it ends (expiry, revocation, logout in
 * another tab) the user is sent to /login.
 */
export function AppShell({ user, children }: { user: PublicUser; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const me = useMe(user);
  const logout = useLogout();
  const unread = useUnreadCount().data?.unread ?? 0;
  useNotificationStream();

  useEffect(
    () => subscribeAuthChanges(() => void qc.invalidateQueries({ queryKey: ME_KEY })),
    [qc],
  );
  useEffect(() => {
    if (me.data === null) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      router.refresh();
    }
  }, [me.data, router, pathname]);

  const current = me.data ?? user;
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 overflow-y-auto border-r border-border bg-surface px-3 py-5 lg:flex">
        <Logo className="px-3" />
        <SidebarNav unread={unread} />
        <div className="mt-auto rounded-xl border border-accent/20 bg-accent-soft p-3 text-xs text-foreground">
          <p className="flex items-center gap-1.5 font-medium text-accent">
            <Sparkles aria-hidden className="size-3.5" /> Verified data only
          </p>
          <p className="mt-1 text-muted-foreground">
            Prices and discounts come from marketplace data, never from the AI.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open navigation"
              >
                <Menu aria-hidden className="size-5" />
              </Button>
            </DialogTrigger>
            <DialogContent side="left" title="Navigation">
              <SidebarNav unread={unread} onNavigate={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
          <Logo className="lg:hidden" />
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" asChild>
              <Link
                href="/notifications"
                aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
              >
                <span className="relative">
                  <Bell aria-hidden className="size-5" />
                  {unread ? (
                    <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent" />
                  ) : null}
                </span>
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
                  <span className="grid size-7 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
                    {(current.name || current.email).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden max-w-40 truncate text-sm sm:inline">{current.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>
                  <span className="block truncate">{current.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings/profile">
                    <UserRound aria-hidden className="size-4" /> Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/security">
                    <Settings aria-hidden className="size-4" /> Security
                  </Link>
                </DropdownMenuItem>
                {current.role === "ADMIN" ? (
                  <DropdownMenuItem asChild>
                    <Link href="/admin">
                      <ShieldCheck aria-hidden className="size-4" /> Admin console
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate()}>
                  <LogOut aria-hidden className="size-4" />
                  {logout.isPending ? "Signing out…" : "Sign out"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
