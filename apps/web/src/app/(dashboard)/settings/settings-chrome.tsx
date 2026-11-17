"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/privacy", label: "Privacy" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 md:flex-col">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={pathname === l.href ? "page" : undefined}
          className={cn(
            "rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
            pathname === l.href && "bg-muted font-medium text-foreground",
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
