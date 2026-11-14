import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { safeNextPath } from "@/lib/api";
import { getServerUser } from "@/lib/server-session";
import { SettingsNav, UserMenu } from "./settings-chrome";

export const metadata: Metadata = {
  title: { default: "Settings", template: "%s · Settings · DealMind AI" },
};

/** Protected area: the session is verified with the API on every request. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const user = await getServerUser();
  if (!user) {
    const path = safeNextPath((await headers()).get("x-pathname"), "/settings/profile");
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
          <Link href="/" className="font-semibold tracking-tight">
            DealMind<span className="text-primary"> AI</span>
          </Link>
          <UserMenu initialUser={user} />
        </div>
      </header>
      <div className="mx-auto grid max-w-4xl gap-6 px-4 py-8 md:grid-cols-[180px_1fr]">
        <SettingsNav />
        <main className="flex min-w-0 flex-col gap-6">{children}</main>
      </div>
    </div>
  );
}
