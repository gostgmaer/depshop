import { ImageOff } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate, rupees } from "@/lib/format";
import type { ProductSummary } from "@/types/api";

export function ProductImage({
  src,
  alt,
  size = 96,
}: {
  src: string | null;
  alt: string;
  size?: number;
}) {
  if (!src)
    return (
      <span
        className="grid shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
        style={{ width: size, height: size }}
      >
        <ImageOff aria-hidden className="size-5" />
        <span className="sr-only">No image</span>
      </span>
    );
  return (
    // Marketplace image hosts vary per source; a plain lazy <img> avoids an image-proxy allow-list.
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 rounded-lg bg-muted object-contain"
      style={{ width: size, height: size }}
    />
  );
}

export function ProductCard({ product }: { product: ProductSummary }) {
  return (
    <article className="group relative flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card) transition-colors hover:border-primary/40">
      <div className="flex items-start gap-3">
        <ProductImage src={product.imageUrl} alt={product.name} size={72} />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{product.brand}</p>
          <h3 className="line-clamp-2 text-sm font-medium">
            <Link
              href={`/products/${product.id}`}
              className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
            >
              {product.name}
            </Link>
          </h3>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-end justify-between gap-2">
        <div>
          {product.lowestPricePaise !== null ? (
            <>
              <p className="text-xs text-muted-foreground">Lowest price</p>
              <p className="text-lg font-semibold tabular">{rupees(product.lowestPricePaise)}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No current offer</p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {product.sampleData ? <Badge tone="warning">Sample data</Badge> : null}
          <Badge tone={product.inStock ? "success" : "neutral"}>
            {product.offerCount} offer{product.offerCount === 1 ? "" : "s"}
          </Badge>
          {product.launchDate ? (
            <Badge tone="outline">Launched {formatDate(product.launchDate)}</Badge>
          ) : null}
        </div>
      </div>
    </article>
  );
}
