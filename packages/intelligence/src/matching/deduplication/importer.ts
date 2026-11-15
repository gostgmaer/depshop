/**
 * Catalog import/upsert. For each listing from an ACTIVE source:
 *   validate → normalize → match → (create product) → upsert variant →
 *   upsert offer (unique per source + externalId) → append a price snapshot
 *   when price/stock changed or the last snapshot is stale.
 * Each listing runs in its own transaction, serialized per brand with an
 * advisory lock so concurrent imports cannot create duplicate products.
 * Uncertain matches are stored in ProductMatchReview and create no offer.
 * Nothing is ever invented: absent fields stay absent.
 */
import { type Prisma, type PrismaClient, isUniqueViolation } from "@dealmind/db";
import type { z } from "zod";
import {
  type NormalizedListing,
  type ValidListing,
  normalizeListing,
  sourceListingSchema,
} from "./listing.js";
import { CatalogMatcher, type MatchDecision } from "./matcher.js";

type Tx = Prisma.TransactionClient;

export interface ImportOptions {
  matcher?: CatalogMatcher;
  /** Append a snapshot even without changes when the last one is older than this. Default 6h. */
  snapshotRefreshMs?: number;
  /** Called with every product id whose catalog data changed (cache invalidation). */
  onProductsChanged?: (productIds: string[]) => Promise<void> | void;
  now?: () => Date;
}

export type ListingOutcome =
  | { status: "rejected"; index: number; externalId?: string; issues: z.ZodIssue[] | string[] }
  | { status: "review"; index: number; externalId: string; reviewId: string; confidence: number }
  | {
      status: "imported";
      index: number;
      externalId: string;
      productId: string;
      variantId: string;
      offerId: string;
      productCreated: boolean;
      variantCreated: boolean;
      offerCreated: boolean;
      snapshotCreated: boolean;
      method: string;
      confidence: number;
    };

export interface ImportSummary {
  source: string;
  received: number;
  imported: number;
  productsCreated: number;
  variantsCreated: number;
  offersCreated: number;
  offersUpdated: number;
  snapshotsCreated: number;
  sentToReview: number;
  rejected: number;
  outcomes: ListingOutcome[];
}

export class SourceNotActiveError extends Error {
  constructor(
    readonly slug: string,
    readonly status: string | null,
  ) {
    super(
      status
        ? `Source "${slug}" is ${status}; only ACTIVE sources can import`
        : `Unknown source "${slug}"`,
    );
    this.name = "SourceNotActiveError";
  }
}

const OFFER_FIELDS_TRACKED = [
  "sellingPricePaise",
  "mrpPaise",
  "shippingPaise",
  "stockStatus",
] as const;

function hostMatches(url: string, domain: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

const big = (v: number | undefined): bigint | null => (v == null ? null : BigInt(v));

export class CatalogImporter {
  private readonly matcher: CatalogMatcher;
  private readonly snapshotRefreshMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: ImportOptions = {},
  ) {
    this.matcher = options.matcher ?? new CatalogMatcher();
    this.snapshotRefreshMs = options.snapshotRefreshMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async importListings(sourceSlug: string, listings: unknown[]): Promise<ImportSummary> {
    const source = await this.prisma.shoppingSource.findUnique({ where: { slug: sourceSlug } });
    if (!source || source.status !== "ACTIVE") {
      throw new SourceNotActiveError(sourceSlug, source?.status ?? null);
    }
    const summary: ImportSummary = {
      source: sourceSlug,
      received: listings.length,
      imported: 0,
      productsCreated: 0,
      variantsCreated: 0,
      offersCreated: 0,
      offersUpdated: 0,
      snapshotsCreated: 0,
      sentToReview: 0,
      rejected: 0,
      outcomes: [],
    };
    const changed = new Set<string>();

    for (const [index, input] of listings.entries()) {
      const parsed = sourceListingSchema.safeParse(input);
      if (!parsed.success) {
        const externalId = (input as { externalId?: unknown } | null)?.externalId;
        summary.outcomes.push({
          status: "rejected",
          index,
          ...(typeof externalId === "string" ? { externalId } : {}),
          issues: parsed.error.issues,
        });
        continue;
      }
      if (!hostMatches(parsed.data.productUrl, source.domain)) {
        summary.outcomes.push({
          status: "rejected",
          index,
          externalId: parsed.data.externalId,
          issues: [`productUrl host is not on the source domain ${source.domain}`],
        });
        continue;
      }
      const outcome = await this.importOne(source.id, index, normalizeListing(parsed.data));
      summary.outcomes.push(outcome);
      if (outcome.status === "imported") changed.add(outcome.productId);
    }

    for (const o of summary.outcomes) {
      if (o.status === "rejected") summary.rejected += 1;
      else if (o.status === "review") summary.sentToReview += 1;
      else {
        summary.imported += 1;
        if (o.productCreated) summary.productsCreated += 1;
        if (o.variantCreated) summary.variantsCreated += 1;
        if (o.offerCreated) summary.offersCreated += 1;
        else summary.offersUpdated += 1;
        if (o.snapshotCreated) summary.snapshotsCreated += 1;
      }
    }
    if (changed.size && this.options.onProductsChanged) {
      await this.options.onProductsChanged([...changed]);
    }
    return summary;
  }

  /** One listing, one transaction; a concurrent unique race is retried once. */
  private async importOne(
    sourceId: string,
    index: number,
    listing: NormalizedListing,
  ): Promise<ListingOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.importInTx(tx, sourceId, index, listing),
          {
            timeout: 15_000,
          },
        );
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  private async importInTx(
    tx: Tx,
    sourceId: string,
    index: number,
    listing: NormalizedListing,
  ): Promise<ListingOutcome> {
    const raw = listing.raw;
    // Serialize imports of the same brand: matching + product creation is check-then-act.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm:catalog:${listing.brandKey}`}))`;

    const existing = await tx.productOffer.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: raw.externalId } },
    });

    let decision: MatchDecision;
    if (existing) {
      // Already matched on an earlier import: keep the product, re-resolve the variant.
      decision = {
        kind: "MATCH",
        productId: existing.productId,
        method: existing.matchMethod,
        confidence: existing.matchConfidence,
        evidence: {
          ...(existing.matchEvidence as object),
          method: existing.matchMethod,
          reason: "previously matched offer",
        },
      };
    } else {
      const pending = await tx.productMatchReview.findUnique({
        where: { sourceId_externalId: { sourceId, externalId: raw.externalId } },
      });
      if (pending?.status === "PENDING") {
        await tx.productMatchReview.update({
          where: { id: pending.id },
          data: { listing: raw as unknown as Prisma.InputJsonValue },
        });
        return {
          status: "review",
          index,
          externalId: raw.externalId,
          reviewId: pending.id,
          confidence: pending.confidence,
        };
      }
      decision = await this.matcher.match(tx, listing);
      if (decision.kind === "REVIEW") {
        const review = await tx.productMatchReview.upsert({
          where: { sourceId_externalId: { sourceId, externalId: raw.externalId } },
          create: {
            sourceId,
            externalId: raw.externalId,
            listing: raw as unknown as Prisma.InputJsonValue,
            candidateProductId: decision.candidateProductId,
            confidence: decision.confidence,
            method: decision.method,
            evidence: decision.evidence as unknown as Prisma.InputJsonValue,
          },
          update: {
            listing: raw as unknown as Prisma.InputJsonValue,
            candidateProductId: decision.candidateProductId,
            confidence: decision.confidence,
            method: decision.method,
            evidence: decision.evidence as unknown as Prisma.InputJsonValue,
            status: "PENDING",
            reviewedAt: null,
          },
        });
        return {
          status: "review",
          index,
          externalId: raw.externalId,
          reviewId: review.id,
          confidence: decision.confidence,
        };
      }
    }
    return this.applyMatch(tx, sourceId, index, listing, decision, existing);
  }

  /** Writes product/variant/offer/snapshot for a MATCH or NEW decision. */
  private async applyMatch(
    tx: Tx,
    sourceId: string,
    index: number,
    listing: NormalizedListing,
    decision: Exclude<MatchDecision, { kind: "REVIEW" }>,
    existing: Prisma.ProductOfferGetPayload<object> | null,
  ): Promise<ListingOutcome> {
    const raw = listing.raw;
    const now = this.now();
    let productCreated = false;
    let productId: string;
    if (decision.kind === "NEW") {
      productId = (await this.createProduct(tx, listing)).id;
      productCreated = true;
    } else {
      productId = decision.productId;
      await this.enrichProduct(tx, productId, listing);
    }

    const variant = await this.upsertVariant(tx, productId, listing, decision);
    const method = decision.kind === "NEW" ? "NEW_PRODUCT" : decision.method;
    const offerData = {
      productUrl: raw.productUrl,
      title: raw.title,
      sellerName: raw.sellerName ?? null,
      mrpPaise: big(raw.mrpPaise),
      sellingPricePaise: BigInt(raw.sellingPricePaise),
      shippingPaise: big(raw.shippingPaise),
      stockStatus: raw.stockStatus,
      currency: raw.currency,
      offerConditions: raw.offerConditions as Prisma.InputJsonValue,
      sourceUpdatedAt: raw.sourceUpdatedAt ?? null,
      observedAt: now,
    };

    let offerId: string;
    let snapshotCreated = false;
    if (existing) {
      const changed = OFFER_FIELDS_TRACKED.some(
        (f) => String(existing[f] ?? "") !== String(offerData[f] ?? ""),
      );
      const updated = await tx.productOffer.update({
        where: { id: existing.id },
        data: { ...offerData, variantId: variant.id, productId },
      });
      offerId = updated.id;
      const last = await tx.priceSnapshot.findFirst({
        where: { offerId },
        orderBy: { observedAt: "desc" },
        select: { observedAt: true },
      });
      if (changed || !last || now.getTime() - last.observedAt.getTime() >= this.snapshotRefreshMs) {
        await this.snapshot(tx, offerId, offerData, now);
        snapshotCreated = true;
      }
    } else {
      const created = await tx.productOffer.create({
        data: {
          ...offerData,
          productId,
          variantId: variant.id,
          sourceId,
          externalId: raw.externalId,
          firstSeenAt: now,
          matchMethod: method,
          matchConfidence: decision.confidence,
          matchEvidence: decision.evidence as unknown as Prisma.InputJsonValue,
        },
      });
      offerId = created.id;
      await this.snapshot(tx, offerId, offerData, now);
      snapshotCreated = true;
    }

    return {
      status: "imported",
      index,
      externalId: raw.externalId,
      productId,
      variantId: variant.id,
      offerId,
      productCreated,
      variantCreated: variant.created,
      offerCreated: !existing,
      snapshotCreated,
      method,
      confidence: decision.confidence,
    };
  }

  private snapshot(
    tx: Tx,
    offerId: string,
    o: {
      mrpPaise: bigint | null;
      sellingPricePaise: bigint;
      shippingPaise: bigint | null;
      stockStatus: ValidListing["stockStatus"];
    },
    observedAt: Date,
  ) {
    return tx.priceSnapshot.create({
      data: {
        offerId,
        mrpPaise: o.mrpPaise,
        sellingPricePaise: o.sellingPricePaise,
        shippingPaise: o.shippingPaise,
        stockStatus: o.stockStatus,
        observedAt,
      },
    });
  }

  private async createProduct(tx: Tx, listing: NormalizedListing) {
    const raw = listing.raw;
    const category = raw.categorySlug
      ? await tx.category.findUnique({ where: { slug: raw.categorySlug }, select: { id: true } })
      : null;
    return tx.product.create({
      data: {
        name: listing.name,
        normalizedName: listing.normalizedName,
        brand: listing.brand,
        modelNumber: listing.modelNumber,
        fingerprint: listing.fingerprint,
        description: raw.description ?? null,
        manufacturer: raw.manufacturer ?? null,
        imageUrl: raw.imageUrl ?? null,
        launchDate: raw.launchDate ?? null,
        specifications: raw.specifications,
        categoryId: category?.id ?? null,
      },
    });
  }

  /** Fills fields that are still empty; never overwrites existing catalog data. */
  private async enrichProduct(tx: Tx, productId: string, listing: NormalizedListing) {
    const raw = listing.raw;
    const p = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    const data: Prisma.ProductUpdateInput = {};
    if (!p.description && raw.description) data.description = raw.description;
    if (!p.manufacturer && raw.manufacturer) data.manufacturer = raw.manufacturer;
    if (!p.imageUrl && raw.imageUrl) data.imageUrl = raw.imageUrl;
    if (!p.launchDate && raw.launchDate) data.launchDate = raw.launchDate;
    if (!p.modelNumber && listing.modelNumber && listing.fingerprint) {
      const taken = await tx.product.findUnique({
        where: { fingerprint: listing.fingerprint },
        select: { id: true },
      });
      if (!taken) {
        data.modelNumber = listing.modelNumber;
        data.fingerprint = listing.fingerprint;
      }
    }
    const specs = (p.specifications ?? {}) as Record<string, unknown>;
    const additions = Object.fromEntries(
      Object.entries(raw.specifications).filter(([k]) => !(k in specs)),
    );
    if (Object.keys(additions).length)
      data.specifications = { ...specs, ...additions } as Prisma.InputJsonValue;
    if (!p.categoryId && raw.categorySlug) {
      const c = await tx.category.findUnique({
        where: { slug: raw.categorySlug },
        select: { id: true },
      });
      if (c) data.category = { connect: { id: c.id } };
    }
    if (Object.keys(data).length) await tx.product.update({ where: { id: productId }, data });
  }

  private async upsertVariant(
    tx: Tx,
    productId: string,
    listing: NormalizedListing,
    decision: Exclude<MatchDecision, { kind: "REVIEW" }>,
  ): Promise<{ id: string; created: boolean }> {
    if (decision.kind === "MATCH" && decision.variantId)
      return { id: decision.variantId, created: false };
    const found = await tx.productVariant.findUnique({
      where: { productId_variantKey: { productId, variantKey: listing.variantKey } },
    });
    const barcode =
      listing.identifiers.ean ?? listing.identifiers.upc ?? listing.identifiers.gtin ?? null;
    const barcodeFree =
      barcode != null &&
      !(await tx.productVariant.findUnique({ where: { gtin: barcode }, select: { id: true } }));
    if (found) {
      const data: Prisma.ProductVariantUpdateInput = {};
      if (!found.sku && listing.raw.sku) data.sku = listing.raw.sku;
      if (!found.gtin && barcodeFree) data.gtin = barcode;
      if (Object.keys(data).length)
        await tx.productVariant.update({ where: { id: found.id }, data });
      return { id: found.id, created: false };
    }
    const created = await tx.productVariant.create({
      data: {
        productId,
        variantKey: listing.variantKey,
        attributes: listing.attributes,
        sku: listing.raw.sku ?? null,
        gtin: barcodeFree ? barcode : null,
      },
    });
    return { id: created.id, created: true };
  }

  /**
   * Resolves a pending review. `match` attaches the listing to a product,
   * `create` makes it a new product, `reject` discards it. The stored listing
   * is replayed through the normal import path.
   */
  async resolveReview(
    reviewId: string,
    resolution:
      { action: "match"; productId: string } | { action: "create" } | { action: "reject" },
  ): Promise<ListingOutcome | null> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const review = await tx.productMatchReview.findUniqueOrThrow({ where: { id: reviewId } });
      if (review.status !== "PENDING")
        throw new Error(`Review ${reviewId} is already ${review.status}`);
      const now = this.now();
      if (resolution.action === "reject") {
        await tx.productMatchReview.update({
          where: { id: reviewId },
          data: { status: "REJECTED", reviewedAt: now },
        });
        return null;
      }
      const source = await tx.shoppingSource.findUniqueOrThrow({ where: { id: review.sourceId } });
      if (source.status !== "ACTIVE") throw new SourceNotActiveError(source.slug, source.status);
      const listing = normalizeListing(sourceListingSchema.parse(review.listing));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm:catalog:${listing.brandKey}`}))`;
      const decision: Exclude<MatchDecision, { kind: "REVIEW" }> =
        resolution.action === "match"
          ? {
              kind: "MATCH",
              productId: (
                await tx.product.findUniqueOrThrow({ where: { id: resolution.productId } })
              ).id,
              method: "MANUAL",
              confidence: 10_000,
              evidence: { method: "MANUAL", reason: "approved by admin review", reviewId },
            }
          : {
              kind: "NEW",
              confidence: 10_000,
              evidence: { method: "NEW_PRODUCT", reason: "admin chose new product", reviewId },
            };
      const existing = await tx.productOffer.findUnique({
        where: {
          sourceId_externalId: { sourceId: review.sourceId, externalId: review.externalId },
        },
      });
      const result = await this.applyMatch(tx, review.sourceId, 0, listing, decision, existing);
      await tx.productMatchReview.update({
        where: { id: reviewId },
        data: { status: "APPROVED", reviewedAt: now },
      });
      return result;
    });
    if (outcome?.status === "imported" && this.options.onProductsChanged) {
      await this.options.onProductsChanged([outcome.productId]);
    }
    return outcome;
  }
}
