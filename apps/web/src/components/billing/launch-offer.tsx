import type { LaunchOfferView, PlanCode } from "@dealmind/shared";
import { Gift } from "lucide-react";
import { Alert } from "@/components/ui/alert";

const RANK: Record<PlanCode, number> = { FREE: 0, PRO: 1, BUSINESS: 2 };

export type FreeLaunch = NonNullable<LaunchOfferView["freeLaunch"]>;

/** "Free during launch" notice (LAUNCH_FREE_PLAN). No dates or urgency: it says what is true now. */
export function LaunchOfferBanner({ offer }: { offer: FreeLaunch }) {
  return (
    <Alert tone="success">
      <Gift aria-hidden className="mr-1 inline size-4" />
      <strong>Free during our launch.</strong> Every account gets the {offer.planName} plan at no
      cost. No payment details needed.
    </Alert>
  );
}

/** What a plan card says while everything is free. */
export function launchPlanNote(planCode: PlanCode, offer: FreeLaunch): string {
  if (planCode === offer.planCode) return `Included free for everyone during the launch.`;
  return RANK[planCode] < RANK[offer.planCode]
    ? `Everything here is included in the free ${offer.planName} plan.`
    : `Paid plans are paused during the launch.`;
}
