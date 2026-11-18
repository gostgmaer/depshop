"use client";

import type { MeResponse } from "@dealmind/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EXAMPLE_QUERIES } from "@/components/search/search-input";
import { api } from "@/lib/api";
import { ME_KEY, useMe } from "@/lib/auth-hooks";

/**
 * First-time introduction (docs/onboarding-flow.md). Shown once, inline below
 * the search box, so it never blocks a search. Skip or finish closes it for
 * good (stored on the account); "?tour=1" reopens it from Settings without
 * changing anything.
 */
export const ONBOARDING_STEPS = [
  {
    title: "Search in plain language",
    body: "Describe what you want, with your budget and the specs that matter. DealMind turns it into filters and searches the marketplaces it is connected to.",
    examples: true,
  },
  {
    title: "The same variant, compared",
    body: "Offers are matched to the exact variant (RAM, storage, size, colour) before prices are compared. Each price shows which marketplace it came from and when it was seen.",
  },
  {
    title: "Genuine discounts",
    body: "A discount is called genuine only when price history supports it. A “discount” from an inflated MRP is flagged, and bank offers or cashback are shown separately, only for the cards you say you have.",
  },
  {
    title: "Track prices and get alerts",
    body: "Add products to a watchlist or set a target price. DealMind checks the price for you and notifies you when it drops, without you searching again.",
  },
  {
    title: "Optional: your preferences",
    body: "You can set preferred brands in your profile. It's optional: searches work the same without it.",
    preferences: true,
  },
] as const;

type Outcome = "completed" | "skipped";

export function OnboardingPanel() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const reopened = params.get("tour") === "1";
  const [step, setStep] = useState(0);
  const [hidden, setHidden] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const close = useMutation({
    mutationFn: (outcome: Outcome) => api<MeResponse>("POST", "/users/me/onboarding", { outcome }),
    onSuccess: (res) => queryClient.setQueryData(ME_KEY, res.user),
  });

  // Move focus to the new step's heading so keyboard and screen-reader users follow along.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) headingRef.current?.focus();
    moved.current = true;
  }, [step]);

  const user = me.data;
  if (!user || hidden || (user.onboardingCompleted && !reopened)) return null;

  const finish = (outcome: Outcome) => {
    setHidden(true);
    if (!user.onboardingCompleted) close.mutate(outcome);
    if (reopened) router.replace(pathname);
  };

  const current = ONBOARDING_STEPS[step]!;
  const last = step === ONBOARDING_STEPS.length - 1;
  return (
    <Card aria-labelledby="onboarding-title" className="border-accent/30">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground" id="onboarding-progress">
          Getting started · step {step + 1} of {ONBOARDING_STEPS.length}
        </p>
        <Button size="sm" variant="ghost" onClick={() => finish("skipped")}>
          Skip introduction
        </Button>
      </div>
      <h2
        id="onboarding-title"
        ref={headingRef}
        tabIndex={-1}
        className="mt-2 text-lg font-semibold tracking-tight outline-none"
      >
        {current.title}
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{current.body}</p>
      {"examples" in current ? (
        <ul className="mt-3 flex flex-col gap-1 text-sm" aria-label="Example searches">
          {EXAMPLE_QUERIES.slice(0, 2).map((q) => (
            <li key={q} className="text-foreground">
              “{q}”
            </li>
          ))}
        </ul>
      ) : null}
      {"preferences" in current ? (
        <p className="mt-3 text-sm">
          <Link
            href="/settings/profile"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Set preferred brands (optional)
          </Link>
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2" aria-describedby="onboarding-progress">
        {step > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : null}
        {last ? (
          <Button size="sm" onClick={() => finish("completed")}>
            Done
          </Button>
        ) : (
          <Button size="sm" onClick={() => setStep(step + 1)}>
            Next
          </Button>
        )}
      </div>
    </Card>
  );
}
