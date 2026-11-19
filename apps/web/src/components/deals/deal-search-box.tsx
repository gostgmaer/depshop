"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Search box over the current deals (stored products only, no store is contacted):
 * opens /deals?q=…; an empty search shows every deal.
 */
export function DealSearchBox({
  initialQuery = "",
  compact = false,
  submitLabel = "Search deals",
  className,
}: {
  initialQuery?: string;
  compact?: boolean;
  submitLabel?: string;
  className?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [q, setQ] = useState(initialQuery);
  return (
    <form
      role="search"
      aria-label="Search deals"
      className={cn("flex w-full gap-2", className)}
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        router.push(term ? `/deals?q=${encodeURIComponent(term)}` : "/deals");
      }}
    >
      <label htmlFor={id} className="sr-only">
        Search deals
      </label>
      <Input
        id={id}
        type="search"
        enterKeyHint="search"
        maxLength={100}
        placeholder="Search deals, e.g. running shoes, 5G phone, mixer grinder"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={cn("flex-1", compact ? "h-10" : "h-12 text-base")}
      />
      <Button type="submit" size={compact ? "default" : "lg"}>
        <Search aria-hidden className="size-4" />
        <span className={compact ? "sr-only sm:not-sr-only" : undefined}>{submitLabel}</span>
      </Button>
    </form>
  );
}
