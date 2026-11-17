import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getServerUser } from "@/lib/server-session";
import { PricingView } from "./pricing-view";

export const metadata: Metadata = {
  title: "Pricing",
  description: "DealMind AI plans: Free, Pro and Business.",
};

export default async function PricingPage() {
  const user = await getServerUser();
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      <nav className="flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-tight">
          DealMind<span className="text-primary"> AI</span>
        </Link>
        <Button size="sm" variant="outline" asChild>
          <Link href={user ? "/billing" : "/login"}>{user ? "Billing" : "Sign in"}</Link>
        </Button>
      </nav>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Plans for every shopper</h1>
        <p className="text-muted-foreground">
          Start free. Upgrade for more searches, alerts, history and bulk tracking. Cancel any time.
        </p>
      </header>
      <PricingView signedIn={Boolean(user)} />
    </main>
  );
}
