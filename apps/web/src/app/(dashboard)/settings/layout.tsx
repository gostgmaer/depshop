import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/misc";
import { SettingsNav } from "./settings-chrome";

export const metadata: Metadata = {
  title: { default: "Settings", template: "%s · Settings · DealMind AI" },
};

/** Authentication is enforced by the (dashboard) layout. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Your profile, preferences and security." />
      <div className="grid gap-6 md:grid-cols-[180px_1fr]">
        <SettingsNav />
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
