"use client";

import { BellRing, LayoutDashboard, Sparkles, Star, UserRound } from "lucide-react";
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
  { href: "/search", label: "Search", icon: Sparkles },
  { href: "/watchlists", label: "Watchlists", icon: Star },
  { href: "/alerts", label: "Alerts", icon: BellRing },
  {
    href: "/settings/profile",
    label: "Account",
    icon: UserRound,
    match: ["/settings", "/billing", "/notifications", "/history"],
  },
];

export function MobileTabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {TAB_ITEMS.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium outline-offset-[-2px]",
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
