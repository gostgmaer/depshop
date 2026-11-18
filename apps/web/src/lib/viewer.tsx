"use client";

import { BellRing } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, createContext, useContext } from "react";
import { Button } from "@/components/ui/button";

/**
 * Who is looking at a page: a signed-in account or a guest (search without an
 * account). Guests can search, view results, products, compare and deals; saving
 * products and price alerts need an account (they notify you by e-mail/push).
 */
const ViewerContext = createContext<{ guest: boolean }>({ guest: false });

export function ViewerProvider({ guest, children }: { guest: boolean; children: ReactNode }) {
  return <ViewerContext.Provider value={{ guest }}>{children}</ViewerContext.Provider>;
}

export const useIsGuest = () => useContext(ViewerContext).guest;

/** Shown to guests in place of watchlist and price-alert controls. */
export function SignInToTrack({
  size = "sm",
  label = "Sign in to track this price",
}: {
  size?: "sm" | "default";
  label?: string;
}) {
  const pathname = usePathname();
  return (
    <Button variant="outline" size={size} asChild>
      <Link href={`/login?next=${encodeURIComponent(pathname)}`}>
        <BellRing aria-hidden className="size-4" />
        {label}
      </Link>
    </Button>
  );
}
