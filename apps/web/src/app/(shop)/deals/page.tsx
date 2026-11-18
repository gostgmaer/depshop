import type { Metadata } from "next";
import { Suspense } from "react";
import { DealsView } from "./deals-view";

export const metadata: Metadata = {
  title: "Deals",
  description:
    "Current deals from products DealMind has already found: priced below the marketplace's stated MRP, in stock and recently seen.",
};

export default function DealsPage() {
  return (
    <Suspense fallback={null}>
      <DealsView />
    </Suspense>
  );
}
