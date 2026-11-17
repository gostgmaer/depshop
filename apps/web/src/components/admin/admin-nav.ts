import {
  Activity,
  BarChart3,
  Bot,
  Boxes,
  CreditCard,
  FolderTree,
  Handshake,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Plug,
  ScrollText,
  Settings,
  Users,
} from "lucide-react";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const ADMIN_NAV: { label: string; items: AdminNavItem[] }[] = [
  { label: "Overview", items: [{ href: "/admin", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "People",
    items: [
      { href: "/admin/users", label: "Users", icon: Users },
      { href: "/admin/subscriptions", label: "Subscriptions", icon: CreditCard },
    ],
  },
  {
    label: "Catalog",
    items: [
      { href: "/admin/products", label: "Products", icon: Boxes },
      { href: "/admin/categories", label: "Categories", icon: FolderTree },
      { href: "/admin/sources", label: "Connectors", icon: Plug },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/admin/ai-models", label: "AI models", icon: Bot },
      { href: "/admin/analytics", label: "Search analytics", icon: BarChart3 },
      { href: "/admin/affiliates", label: "Affiliates", icon: Handshake },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/admin/jobs", label: "Jobs", icon: ListChecks },
      { href: "/admin/system", label: "System health", icon: Activity },
      { href: "/admin/audit-logs", label: "Audit log", icon: ScrollText },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function isAdminActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}
