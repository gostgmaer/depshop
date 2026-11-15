import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingRows } from "@/components/ui/skeleton";
import { ProductsView } from "./products-view";

export const metadata: Metadata = { title: "Products" };

export default function ProductsPage() {
  return (
    <Suspense fallback={<LoadingRows rows={4} label="Loading products" />}>
      <ProductsView />
    </Suspense>
  );
}
