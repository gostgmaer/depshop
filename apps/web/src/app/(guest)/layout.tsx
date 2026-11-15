import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getServerUser } from "@/lib/server-session";

/** Sign-in and sign-up are for signed-out visitors only. */
export default async function GuestLayout({ children }: { children: ReactNode }) {
  if (await getServerUser()) redirect("/dashboard");
  return children;
}
