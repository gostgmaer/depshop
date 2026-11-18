import { redirect } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getServerUser } from "@/lib/server-session";

export const metadata: Metadata = { robots: { index: false, follow: true } };

/** Sign-in and sign-up are for signed-out visitors only. */
export default async function GuestLayout({ children }: { children: ReactNode }) {
  if (await getServerUser()) redirect("/dashboard");
  return children;
}
