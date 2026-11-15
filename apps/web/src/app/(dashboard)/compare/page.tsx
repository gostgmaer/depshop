import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingRows } from "@/components/ui/skeleton";
import { CompareView } from "./compare-view";

export const metadata: Metadata = { title: "Compare prices" };

export default function ComparePage() {
  return (
    <Suspense fallback={<LoadingRows rows={3} label="Loading comparison" />}>
      <CompareView />
    </Suspense>
  );
}
