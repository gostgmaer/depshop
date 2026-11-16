/**
 * Response types of the Fastify API, inferred from the shared Zod contracts
 * (the same schemas the API validates its responses with).
 */
import type {
  agentRunSummary,
  alertEvaluationView,
  createAlertInput,
  alertView,
  categoryDetail,
  categoryView,
  notificationView,
  offerView,
  planView,
  priceHistory,
  productDetail,
  productSummary,
  searchDetail,
  searchSourceRunView,
  searchView,
  sourceStatus,
  subscriptionView,
  usageView,
  variantView,
  watchlistDetail,
  watchlistItemView,
  watchlistView,
} from "@dealmind/shared";
import type { z } from "zod";

export type {
  CategoryFiltersView,
  CompareView,
  RecommendationsView,
  CategoryNode,
  EvaluatedBenefitView,
  OfferPricingView,
  PriceHistoryStatsView,
  PricingResultView,
  ProductPricingView,
  PublicUser,
  SearchEvent,
  SearchResultView,
  SearchResultSort,
  SearchSortMode,
} from "@dealmind/shared";

export type Category = z.infer<typeof categoryView>;
export type CategoryDetail = z.infer<typeof categoryDetail>;
export type ProductSummary = z.infer<typeof productSummary>;
export type ProductDetail = z.infer<typeof productDetail>;
export type Variant = z.infer<typeof variantView>;
export type Offer = z.infer<typeof offerView>;
export type PriceHistory = z.infer<typeof priceHistory>;
export type SourceStatus = z.infer<typeof sourceStatus>;
export type Search = z.infer<typeof searchView>;
export type SearchDetail = z.infer<typeof searchDetail>;
export type SearchSourceRun = z.infer<typeof searchSourceRunView>;
export type AgentRun = z.infer<typeof agentRunSummary>;
export type Watchlist = z.infer<typeof watchlistView>;
export type WatchlistDetail = z.infer<typeof watchlistDetail>;
export type WatchlistItem = z.infer<typeof watchlistItemView>;
export type PriceAlert = z.infer<typeof alertView>;
export type AlertEvaluation = z.infer<typeof alertEvaluationView>;
/** Request body of POST /alerts (type defaults to TARGET_PRICE). */
export type CreateAlertRequest = z.input<typeof createAlertInput>;
export type Notification = z.infer<typeof notificationView>;
export type Plan = z.infer<typeof planView>;
export type Subscription = z.infer<typeof subscriptionView>;
export type Usage = z.infer<typeof usageView>;
