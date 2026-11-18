import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { GuestShell } from "@/components/layout/guest-shell";
import { getServerUser } from "@/lib/server-session";

export const metadata: Metadata = { robots: { index: false } };

/**
 * Shopping pages anyone can use without an account: search (as a guest), results,
 * products, categories, comparison and deals. Signed-in users get the full app shell;
 * visitors get the guest shell. Account features live in (dashboard), which requires
 * an account.
 */
export default async function ShopLayout({ children }: { children: ReactNode }) {
  const user = await getServerUser();
  return user ? <AppShell user={user}>{children}</AppShell> : <GuestShell>{children}</GuestShell>;
}
