import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { safeNextPath } from "@/lib/api";
import { getServerUser } from "@/lib/server-session";

export const metadata: Metadata = {
  title: { template: "%s · Admin · DealMind AI", default: "Admin · DealMind AI" },
  robots: { index: false, follow: false },
};

/**
 * Platform administration. The role comes from the API's view of the session
 * (never from the client); non-admins get a 404 so the area isn't advertised.
 * Every admin API call is authorized again by the API.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getServerUser();
  if (!user) {
    const path = safeNextPath((await headers()).get("x-pathname"));
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  if (user.role !== "ADMIN") notFound();
  return <AdminShell user={user}>{children}</AdminShell>;
}
