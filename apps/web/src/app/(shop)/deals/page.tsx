import type { Metadata } from "next";
import { Suspense } from "react";
import { DealsView } from "./deals-view";

export const metadata: Metadata = {
  title: "Deals",
  description:
    "Current deals from the connected stores: well below the store's stated MRP, in stock and recently seen. Search them by product, brand or category.",
};

export default function DealsPage() {
  return (
    <Suspense fallback={null}>
      <DealsView />
    </Suspense>
  );
}
