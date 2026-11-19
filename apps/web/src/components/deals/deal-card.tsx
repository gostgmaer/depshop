import { Clock, FlaskConical, Store } from "lucide-react";
import Link from "next/link";
import { ProductImage } from "@/components/products/product-card";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { percent, relativeTime, rupees, variantSummary } from "@/lib/format";
import type { Deal } from "@/types/api";

/**
 * One current deal: best live offer for a variant. The name opens the product page
 * (all offers, price history, buy links through the affiliate redirect).
 */
export function DealCard({ deal: d, headingLevel = 2 }: { deal: Deal; headingLevel?: 2 | 3 }) {
  const variant = variantSummary(d.attributes).join(" · ");
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <li>
      <Card className="flex h-full flex-col gap-3">
        <div className="flex gap-3">
          <ProductImage src={d.imageUrl} alt={d.name} size={72} />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {d.brand}
              {d.category ? ` · ${d.category.name}` : ""}
            </p>
            <Heading className="font-medium">
              <Link
                href={`/products/${d.productId}`}
                className="underline-offset-4 hover:underline"
              >
                {d.name}
              </Link>
            </Heading>
            {variant ? <p className="text-xs text-muted-foreground">{variant}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xl font-semibold tabular">{rupees(d.offer.sellingPricePaise)}</span>
          <span className="text-sm text-muted-foreground line-through tabular">
            {rupees(d.offer.mrpPaise)}
          </span>
          <Badge tone="success">{percent(d.offer.discountBp)} off MRP</Badge>
        </div>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <Store aria-hidden className="size-3.5" />
            {d.offer.sourceName}
            {d.offerCount > 1 ? ` · deal at ${d.offerCount} stores` : ""}
          </li>
          <li className="flex items-center gap-1.5">
            <Clock aria-hidden className="size-3.5" />
            Price seen {relativeTime(d.offer.observedAt)}
            {d.offer.shippingPaise === null
              ? " · shipping not stated"
              : d.offer.shippingPaise > 0
                ? ` · + ${rupees(d.offer.shippingPaise)} shipping`
                : " · free shipping"}
          </li>
        </ul>
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <Link
            href={`/products/${d.productId}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Price history &amp; buy
          </Link>
          {d.offer.isSample ? (
            <Badge tone="warning">
              <FlaskConical aria-hidden className="size-3" /> Sample data (mock store)
            </Badge>
          ) : null}
        </div>
      </Card>
    </li>
  );
}
