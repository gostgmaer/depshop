import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { RecentSearches } from "@/components/dashboard/widgets";
import { AiSearchBar } from "@/components/search/ai-search-bar";
import { EXAMPLE_QUERIES } from "@/components/search/search-input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";

export const metadata: Metadata = { title: "AI Search" };

export default function SearchPage() {
  return (
    <>
      <PageHeader
        eyebrow={
          <Badge tone="ai">
            <Sparkles aria-hidden className="size-3" /> AI shopping search
          </Badge>
        }
        title="What are you shopping for?"
        description="Describe it in your own words. The AI interprets your request; prices, discounts and rankings are computed from marketplace data."
      />
      <AiSearchBar initialFilters />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Try asking" />
          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            {EXAMPLE_QUERIES.map((q) => (
              <li key={q} className="flex gap-2">
                <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" /> {q}
              </li>
            ))}
          </ul>
        </Card>
        <RecentSearches />
      </div>
    </>
  );
}
