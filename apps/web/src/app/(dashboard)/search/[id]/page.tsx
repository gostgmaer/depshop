import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingRows } from "@/components/ui/skeleton";
import { SearchView } from "./search-view";

export const metadata: Metadata = { title: "Search results" };

export default async function SearchResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<LoadingRows rows={3} label="Loading search" />}>
      <SearchView id={id} />
    </Suspense>
  );
}
