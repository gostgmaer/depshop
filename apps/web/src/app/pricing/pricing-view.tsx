"use client";

import type { BillingIntervalValue } from "@dealmind/shared";
import Link from "next/link";
import { useState } from "react";
import { IntervalToggle, PRICE_NOTE, PlanCards } from "@/components/billing/plan-cards";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { LaunchOfferBanner, launchPlanNote } from "@/components/billing/launch-offer";
import { useLaunchOffer, usePlans } from "@/hooks/queries";

export function PricingView({ signedIn }: { signedIn: boolean }) {
  const plans = usePlans();
  const offer = useLaunchOffer().data?.freeLaunch ?? null;
  const [interval, setInterval] = useState<BillingIntervalValue>("MONTHLY");
  if (plans.isPending) return <LoadingRows rows={3} label="Loading plans" />;
  if (plans.isError)
    return <ErrorState message="Couldn't load plans." onRetry={() => void plans.refetch()} />;
  return (
    <>
      <p className="text-muted-foreground">
        {offer
          ? "DealMind is free while we launch: search, compare, track prices and get alerts at no cost."
          : "Start free. Upgrade for more searches, alerts, history and bulk tracking. Cancel any time."}
      </p>
      {offer ? <LaunchOfferBanner offer={offer} /> : null}
      {offer ? null : <IntervalToggle value={interval} onChange={setInterval} plans={plans.data} />}
      <PlanCards
        plans={plans.data}
        interval={interval}
        action={(p) =>
          offer ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{launchPlanNote(p.code, offer)}</p>
              {p.code === offer.planCode ? (
                <Button className="w-full" asChild>
                  <Link href={signedIn ? "/dashboard" : "/register?next=%2Fdashboard"}>
                    {signedIn ? "Go to your dashboard" : "Create a free account"}
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : (
            <Button className="w-full" variant={p.code === "FREE" ? "outline" : "default"} asChild>
              <Link
                href={
                  signedIn
                    ? "/billing"
                    : `/register?next=${encodeURIComponent(p.code === "FREE" ? "/dashboard" : "/billing")}`
                }
              >
                {p.code === "FREE" ? "Start free" : `Choose ${p.name}`}
              </Link>
            </Button>
          )
        }
      />
      {offer ? null : <p className="text-xs text-muted-foreground">{PRICE_NOTE}</p>}
    </>
  );
}
