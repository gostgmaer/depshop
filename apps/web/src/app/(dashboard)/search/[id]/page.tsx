import type { Metadata } from "next";
import { SearchView } from "./search-view";

export const metadata: Metadata = { title: "Search results" };

export default async function SearchResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SearchView id={id} />;
}
