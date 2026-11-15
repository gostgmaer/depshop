import type { Metadata } from "next";
import { publicGet } from "@/lib/server-api";
import type { ProductDetail } from "@/types/api";
import { ProductView } from "./product-view";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const product = await publicGet<ProductDetail>(`/products/${encodeURIComponent(id)}`);
  return product
    ? {
        title: product.name,
        description: `${product.brand} ${product.name}: prices across marketplaces, price history and verified discounts.`,
      }
    : { title: "Product" };
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;
  return <ProductView id={id} />;
}
