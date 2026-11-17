"use client";

import type { BillingIntervalValue } from "@dealmind/shared";
import Link from "next/link";
import { useState } from "react";
import { IntervalToggle, PRICE_NOTE, PlanCards } from "@/components/billing/plan-cards";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { usePlans } from "@/hooks/queries";

export function PricingView({ signedIn }: { signedIn: boolean }) {
  const plans = usePlans();
  const [interval, setInterval] = useState<BillingIntervalValue>("MONTHLY");
  if (plans.isPending) return <LoadingRows rows={3} label="Loading plans" />;
  if (plans.isError)
    return <ErrorState message="Couldn't load plans." onRetry={() => void plans.refetch()} />;
  return (
    <>
      <IntervalToggle value={interval} onChange={setInterval} plans={plans.data} />
      <PlanCards
        plans={plans.data}
        interval={interval}
        action={(p) => (
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
        )}
      />
      <p className="text-xs text-muted-foreground">{PRICE_NOTE}</p>
    </>
  );
}
