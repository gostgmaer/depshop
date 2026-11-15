import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LoadingRows } from "@/components/ui/skeleton";
import { publicGet } from "@/lib/server-api";
import type { CategoryDetail } from "@/types/api";
import { ProductsView } from "../../products/products-view";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = await publicGet<CategoryDetail>(`/categories/${encodeURIComponent(slug)}`);
  return { title: c?.name ?? "Category" };
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const c = await publicGet<CategoryDetail>(`/categories/${encodeURIComponent(slug)}`);
  return (
    <>
      {c ? (
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1.5">
            <li>
              <Link href="/categories" className="hover:underline">
                Categories
              </Link>
            </li>
            {c.breadcrumb.map((b, i) => (
              <li key={b.id} className="flex items-center gap-1.5">
                <span aria-hidden>/</span>
                {i === c.breadcrumb.length - 1 ? (
                  <span aria-current="page" className="text-foreground">
                    {b.name}
                  </span>
                ) : (
                  <Link href={`/categories/${b.slug}`} className="hover:underline">
                    {b.name}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <Suspense fallback={<LoadingRows rows={4} label="Loading products" />}>
        <ProductsView
          title={c ? `${c.name} (${c.productCount})` : "Category"}
          fixedCategory={slug}
        />
      </Suspense>
    </>
  );
}
