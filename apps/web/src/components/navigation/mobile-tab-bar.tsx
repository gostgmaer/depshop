"use client";

import {
  BellRing,
  GitCompareArrows,
  Home,
  LayoutDashboard,
  LogIn,
  LayoutGrid,
  Star,
  Tag,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { type NavItem, isActive } from "./nav-items";

/**
 * Bottom navigation on phones and small tablets (hidden from `lg`, where the
 * sidebar takes over). Five destinations only; everything else stays in the
 * menu sheet. Plain links: browser back/forward and deep links work as usual.
 */
export const TAB_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/deals", label: "Deals", icon: Tag, match: ["/search"] },
  { href: "/watchlists", label: "Watchlists", icon: Star },
  { href: "/alerts", label: "Alerts", icon: BellRing },
  {
    href: "/settings/profile",
    label: "Account",
    icon: UserRound,
    match: ["/settings", "/billing", "/notifications", "/history"],
  },
];

/** Visitors without an account (public shopping pages). */
export const GUEST_TAB_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/deals", label: "Deals", icon: Tag, match: ["/search"] },
  { href: "/categories", label: "Categories", icon: LayoutGrid, match: ["/products"] },
  { href: "/compare", label: "Compare", icon: GitCompareArrows },
  { href: "/login", label: "Sign in", icon: LogIn },
];

// A string variant (not the item list) so server components can render it: icons are functions.
export function MobileTabBar({ variant = "account" }: { variant?: "account" | "guest" }) {
  const items = variant === "guest" ? GUEST_TAB_ITEMS : TAB_ITEMS;
  const pathname = usePathname();
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {items.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium outline-offset-[-2px]",
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden className={cn("size-5", active && "stroke-[2.25]")} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
