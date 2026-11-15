import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { safeNextPath } from "@/lib/api";
import { getServerUser } from "@/lib/server-session";

export const metadata: Metadata = { robots: { index: false } };

/**
 * Protected area: the session cookie is verified with the API on every
 * request (never trusted by mere presence). Signed-out visitors go to
 * /login?next=<path>.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await getServerUser();
  if (!user) {
    const path = safeNextPath((await headers()).get("x-pathname"));
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return <AppShell user={user}>{children}</AppShell>;
}
