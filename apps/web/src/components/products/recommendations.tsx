"use client";

/**
 * Deterministic best-deal picks from the pricing/ranking engines. Each label
 * shows the offer and the reasons built from its own data, or why no offer
 * qualifies. Affiliate commission is not an input.
 */
import { BadgeCheck, CircleSlash, History, Scale, Trophy, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { rupees } from "@/lib/format";
import type { RecommendationsView } from "@/types/api";

type Kind = RecommendationsView["items"][number]["kind"];

export const RECOMMENDATION_LABEL: Record<Kind, { label: string; icon: LucideIcon }> = {
  lowest_delivered: { label: "Lowest delivered price", icon: Trophy },
  highest_direct_discount: { label: "Highest verified direct discount", icon: BadgeCheck },
  best_value: { label: "Best value", icon: Scale },
  best_history_position: { label: "Best historical price position", icon: History },
};

const EXCLUSION_TEXT: Record<string, string> = {
  STALE_PRICE: "price not observed in the last 24 hours",
  UNAVAILABLE: "out of stock",
  INDICATIVE_PRICE: "indicative price only",
};

export function RecommendationsCard({
  data,
  /** Names for the picked offer (e.g. the product in a multi-product comparison). */
  describe,
  title = "Best deal recommendations",
}: {
  data: RecommendationsView;
  describe?: (r: RecommendationsView["items"][number]) => string | null;
  title?: string;
}) {
  const excluded = data.excluded.filter((e) => e.count > 0);
  return (
    <Card aria-labelledby="reco-title">
      <CardHeader
        title={<span id="reco-title">{title}</span>}
        description={`From ${data.considered} current offer${data.considered === 1 ? "" : "s"}. ${data.basis}`}
      />
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {data.items.map((r) => {
          const { label, icon: Icon } = RECOMMENDATION_LABEL[r.kind];
          const who = describe?.(r);
          return (
            <li
              key={r.kind}
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
              aria-label={label}
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
                <Icon aria-hidden className="size-4 text-primary" /> {label}
              </p>
              {r.offerId ? (
                <>
                  <p className="text-lg font-semibold tabular">{rupees(r.deliveredPricePaise)}</p>
                  <p className="text-sm">
                    {who ? <span className="font-medium">{who} · </span> : null}
                    {r.marketplace?.name}
                  </p>
                  <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {r.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <CircleSlash aria-hidden className="mt-px size-3.5 shrink-0" />
                  {r.unavailableReason}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {excluded.length ? (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Not considered:
          {excluded.map((e) => (
            <Badge key={e.reason} tone="neutral">
              {e.count} {EXCLUSION_TEXT[e.reason] ?? e.reason.toLowerCase().replace(/_/g, " ")}
            </Badge>
          ))}
        </p>
      ) : null}
    </Card>
  );
}
