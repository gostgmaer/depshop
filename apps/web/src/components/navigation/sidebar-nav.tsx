"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS, isActive } from "./nav-items";

export function Logo({ className, href = "/dashboard" }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-lg font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        className,
      )}
    >
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-lg bg-linear-to-br from-primary to-accent text-[13px] font-bold text-primary-foreground"
      >
        D
      </span>
      <span>
        DealMind<span className="text-accent"> AI</span>
      </span>
    </Link>
  );
}

/** Primary navigation (sidebar on desktop, sheet on mobile). */
export function SidebarNav({ onNavigate, unread }: { onNavigate?: () => void; unread?: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-6">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label} className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {section.label}
          </p>
          {section.items.map((item) => {
            const active = isActive(pathname, item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground outline-none transition-colors",
                  "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
                  active && "bg-muted font-medium text-foreground",
                )}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-4",
                    active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                <span className="flex-1">{item.label}</span>
                {item.href === "/notifications" && unread ? (
                  <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-foreground tabular">
                    {unread > 99 ? "99+" : unread}
                    <span className="sr-only"> unread</span>
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
