import {
  Bell,
  BellRing,
  CreditCard,
  GitCompareArrows,
  History,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  Settings,
  Sparkles,
  Star,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Other path prefixes that mark this item as current. */
  match?: string[];
}

export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Shop",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/search", label: "AI Search", icon: Sparkles },
      { href: "/categories", label: "Categories", icon: LayoutGrid, match: ["/products"] },
      { href: "/compare", label: "Compare", icon: GitCompareArrows },
    ],
  },
  {
    label: "Track",
    items: [
      { href: "/watchlists", label: "Watchlists", icon: Star },
      { href: "/alerts", label: "Price Alerts", icon: BellRing },
      { href: "/history", label: "Search History", icon: History },
      { href: "/notifications", label: "Notifications", icon: Bell },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/settings/profile", label: "Settings", icon: Settings, match: ["/settings"] },
      { href: "/billing", label: "Subscription", icon: CreditCard },
    ],
  },
];

export function isActive(pathname: string, item: NavItem): boolean {
  const prefixes = [item.href, ...(item.match ?? [])];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
