import type { PlanCode } from "./schemas.js";

export interface PlanLimits {
  searchesPerDay: number;
  activeAlerts: number;
  watchlists: number;
}

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  monthlyPricePaise: number;
  limits: PlanLimits;
}

/** Default plan catalogue. Admins can edit plans at runtime; this is the seed. */
export const DEFAULT_PLANS: Record<PlanCode, PlanDefinition> = {
  FREE: {
    code: "FREE",
    name: "Free",
    monthlyPricePaise: 0,
    limits: { searchesPerDay: 20, activeAlerts: 5, watchlists: 2 },
  },
  PRO: {
    code: "PRO",
    name: "Pro",
    monthlyPricePaise: 19_900,
    limits: { searchesPerDay: 200, activeAlerts: 100, watchlists: 20 },
  },
  BUSINESS: {
    code: "BUSINESS",
    name: "Business",
    monthlyPricePaise: 99_900,
    limits: { searchesPerDay: 2_000, activeAlerts: 1_000, watchlists: 200 },
  },
};
