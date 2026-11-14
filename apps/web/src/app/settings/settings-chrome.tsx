"use client";

import type { PublicUser } from "@dealmind/shared";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ME_KEY, subscribeAuthChanges, useLogout, useMe } from "@/lib/auth-hooks";
import { cn } from "@/lib/utils";

const links = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/security", label: "Security" },
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

/**
 * Shows the signed-in user and keeps the page in sync with the server
 * session: if the session ends (logout in another tab, revocation, expiry),
 * the user is sent to /login.
 */
export function UserMenu({ initialUser }: { initialUser: PublicUser }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe(initialUser);
  const logout = useLogout();

  useEffect(
    () => subscribeAuthChanges(() => void queryClient.invalidateQueries({ queryKey: ME_KEY })),
    [queryClient],
  );

  useEffect(() => {
    if (me.data === null) {
      router.replace("/login");
      router.refresh();
    }
  }, [me.data, router]);

  return (
    <div className="flex items-center gap-3">
      <span className="hidden truncate text-sm text-muted-foreground sm:inline">
        {me.data?.email}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        {logout.isPending ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
