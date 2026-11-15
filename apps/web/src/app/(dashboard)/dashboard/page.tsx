import type { Metadata } from "next";
import {
  ActiveAlerts,
  ActivityOverview,
  BestDeals,
  RecentSearches,
  RecentlyLaunched,
  SourceStatusCard,
  TrendingDeals,
  WatchedUpdates,
  Welcome,
} from "@/components/dashboard/widgets";
import { AiSearchBar } from "@/components/search/ai-search-bar";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <Welcome />
      <AiSearchBar />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <BestDeals />
          <RecentlyLaunched />
          <div className="grid gap-6 md:grid-cols-2">
            <WatchedUpdates />
            <ActiveAlerts />
          </div>
        </div>
        <div className="flex flex-col gap-6">
          <ActivityOverview />
          <RecentSearches />
          <SourceStatusCard />
          <TrendingDeals />
        </div>
      </div>
    </>
  );
}
