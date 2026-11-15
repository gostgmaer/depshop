/**
 * Catalog import / deduplication. For each listing from an ACTIVE source:
 *   validate → normalize → duplicate-offer check → match (MatchingEngine) →
 *   create product | place variant | send to review → upsert offer
 *   (unique per source + externalId) → append a price snapshot when price or
 *   stock changed or the last snapshot is stale → audit the decision.
 *
 * One transaction per listing, serialized per brand with an advisory lock so
 * concurrent imports can't create duplicate products; a unique-violation race
 * is retried once. Uncertain matches go to ProductMatchReview and create no
 * offer. Nothing is invented: absent fields stay absent.
 */
import {
  type NormalizedListing,
  type ValidListing,
  canonicalUrl,
  normalizeListing,
  sourceListingSchema,
} from "@dealmind/catalog";
import { type Prisma, type PrismaClient, isUniqueViolation } from "@dealmind/db";
import type { z } from "zod";
import { MatchingEngine } from "../engine.js";
import { matchVariant } from "../matchers/variant-matcher.js";
import { storeEmbedding } from "../matchers/semantic-matcher.js";
import {
  DEFAULT_MATCHING_CONFIG,
  ENGINE_VERSION,
  type MatchingConfig,
  confidenceOf,
} from "../scoring/config.js";
import type { PairResult } from "../scoring/score.js";
import { listingSubject, productSubject } from "../subject.js";
import { productRowInclude } from "../engine.js";

type Tx = Prisma.TransactionClient;

export interface ImportOptions {
  engine?: MatchingEngine;
  /** Append a snapshot even without changes when the last one is older than this. Default 6h. */
  snapshotRefreshMs?: number;
  /** Called with every product id whose catalog data changed (cache invalidation). */
  onProductsChanged?: (productIds: string[]) => Promise<void> | void;
  now?: () => Date;
}

export type ListingOutcome =
  | { status: "rejected"; index: number; externalId?: string; issues: z.ZodIssue[] | string[] }
  | {
      status: "review";
      index: number;
      externalId: string;
      reviewId: string;
      auditId: string;
      confidence: number;
    }
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
      auditId: string | null;
      /** Set when the listing duplicated an existing offer (same source, same canonical URL). */
      duplicateOfOfferId?: string;
    };

export interface ImportSummary {
  source: string;
  received: number;
  imported: number;
  productsCreated: number;
  variantsCreated: number;
  offersCreated: number;
  offersUpdated: number;
  duplicateOffers: number;
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

export class ReviewInputError extends Error {
  override readonly name = "ReviewInputError";
}

export interface Reviewer {
  /** Admin user id of the HUMAN reviewer. Services and AI agents never review. */
  userId: string;
  note?: string;
}

export type ReviewResolution =
  | { action: "match"; productId: string; variantId?: string; newVariant?: boolean }
  | { action: "create" }
  | { action: "reject" };

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
/** Validated JSON-safe values → Prisma JSON input. */
const json = (v: unknown) => v as Prisma.InputJsonValue;

function pairEvidence(p: PairResult | null): Prisma.InputJsonValue {
  if (!p) return {};
  return json({
    ...p.evidence,
    conflicts: p.conflicts,
    variant: p.variant ?? null,
    productB: p.productB,
    score: p.score,
  });
}

export class CatalogImporter {
  readonly engine: MatchingEngine;
  private readonly snapshotRefreshMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: ImportOptions = {},
  ) {
    this.engine = options.engine ?? new MatchingEngine();
    this.snapshotRefreshMs = options.snapshotRefreshMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async importListings(sourceSlug: string, listings: unknown[]): Promise<ImportSummary> {
    const source = await this.prisma.shoppingSource.findUnique({ where: { slug: sourceSlug } });
    if (!source || source.status !== "ACTIVE")
      throw new SourceNotActiveError(sourceSlug, source?.status ?? null);
    const summary: ImportSummary = {
      source: sourceSlug,
      received: listings.length,
      imported: 0,
      productsCreated: 0,
      variantsCreated: 0,
      offersCreated: 0,
      offersUpdated: 0,
      duplicateOffers: 0,
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
        if (o.duplicateOfOfferId) summary.duplicateOffers += 1;
        if (o.snapshotCreated) summary.snapshotsCreated += 1;
      }
    }
    if (changed.size && this.options.onProductsChanged)
      await this.options.onProductsChanged([...changed]);
    return summary;
  }

  private async importOne(
    sourceId: string,
    index: number,
    listing: NormalizedListing,
  ): Promise<ListingOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.importInTx(tx, sourceId, index, listing),
          { timeout: 20_000 },
        );
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  private async lockBrand(tx: Tx, brandKey: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm:catalog:${brandKey}`}))`;
  }

  private async importInTx(
    tx: Tx,
    sourceId: string,
    index: number,
    listing: NormalizedListing,
  ): Promise<ListingOutcome> {
    const raw = listing.raw;
    await this.lockBrand(tx, listing.brandKey);
    const url = canonicalUrl(raw.productUrl);

    let existing = await tx.productOffer.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: raw.externalId } },
    });
    let duplicateOf: string | undefined;
    let auditId: string | null = null;
    if (!existing && url) {
      // Same page under another external id: one listing, not a second offer.
      const dup = await tx.productOffer.findFirst({ where: { sourceId, canonicalUrl: url } });
      if (dup) {
        existing = dup;
        duplicateOf = dup.id;
        auditId = await this.audit(tx, {
          subject: "LISTING",
          origin: "IMPORT",
          sourceId,
          externalId: raw.externalId,
          listing: raw,
          candidateProductId: dup.productId,
          candidateVariantId: dup.variantId,
          resultProductId: dup.productId,
          resultVariantId: dup.variantId,
          scoreBp: 10_000,
          decision: "DUPLICATE_OFFER",
          method: dup.matchMethod,
          evidence: {
            canonicalUrl: url,
            existingExternalId: dup.externalId,
            existingOfferId: dup.id,
          },
        });
      }
    }

    if (existing) {
      // Already matched on an earlier import: keep the product; place the variant safely.
      const product = await tx.product.findUniqueOrThrow({
        where: { id: existing.productId },
        include: productRowInclude,
      });
      const placement = matchVariant(
        listingSubject(listing).variants[0]!,
        productSubject(product).variants,
        listingSubject(listing).profile,
      );
      const variant =
        placement.relation === "SAME_VARIANT"
          ? { id: placement.variantId, created: false }
          : placement.relation === "NEW_VARIANT"
            ? await this.createVariant(tx, existing.productId, listing)
            : { id: existing.variantId, created: false };
      return this.writeOffer(
        tx,
        sourceId,
        index,
        listing,
        existing.productId,
        variant,
        false,
        existing,
        {
          method: existing.matchMethod,
          confidence: existing.matchConfidence,
          evidence: existing.matchEvidence,
          auditId,
          ...(duplicateOf ? { duplicateOf } : {}),
        },
      );
    }

    const pending = await tx.productMatchReview.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: raw.externalId } },
    });
    if (pending?.status === "PENDING") {
      await tx.productMatchReview.update({
        where: { id: pending.id },
        data: { listing: json(raw) },
      });
      return {
        status: "review",
        index,
        externalId: raw.externalId,
        reviewId: pending.id,
        auditId: pending.auditId ?? "",
        confidence: pending.confidence,
      };
    }

    const result = await this.engine.matchListing(tx, listing, raw.categorySlug ?? null);
    const best = result.best;
    if (result.decision === "MANUAL_REVIEW") {
      auditId = await this.audit(tx, {
        subject: "LISTING",
        origin: "IMPORT",
        sourceId,
        externalId: raw.externalId,
        listing: raw,
        candidateProductId: best!.productB.id,
        candidateVariantId:
          best!.variant && "variantId" in best!.variant ? (best!.variant.variantId ?? null) : null,
        scoreBp: best!.scoreBp,
        decision: "MANUAL_REVIEW",
        method: best!.method,
        evidence: pairEvidence(best),
        conflicts: best!.conflicts,
      });
      const review = await this.upsertReview(tx, sourceId, raw, best!, auditId);
      return {
        status: "review",
        index,
        externalId: raw.externalId,
        reviewId: review.id,
        auditId,
        confidence: best!.scoreBp,
      };
    }

    let productId: string;
    let productCreated = false;
    let variant: { id: string; created: boolean };
    if (result.decision === "AUTO_MERGE") {
      productId = result.productId!;
      await this.enrichProduct(tx, productId, listing);
      variant = result.variantId
        ? { id: result.variantId, created: false }
        : await this.createVariant(tx, productId, listing);
    } else {
      productId = (await this.createProduct(tx, listing)).id;
      productCreated = true;
      variant = await this.createVariant(tx, productId, listing);
    }
    auditId = await this.audit(tx, {
      subject: "LISTING",
      origin: "IMPORT",
      sourceId,
      externalId: raw.externalId,
      listing: raw,
      candidateProductId: best?.productB.id ?? null,
      candidateVariantId: result.variantId ?? null,
      resultProductId: productId,
      resultVariantId: variant.id,
      scoreBp: result.decision === "AUTO_MERGE" ? best!.scoreBp : (best?.scoreBp ?? 0),
      decision: result.decision === "AUTO_MERGE" ? "AUTO_MERGE" : "NEW_PRODUCT",
      method: result.decision === "AUTO_MERGE" ? best!.method : "NEW_PRODUCT",
      evidence: pairEvidence(best),
      conflicts: best?.conflicts ?? [],
    });
    return this.writeOffer(tx, sourceId, index, listing, productId, variant, productCreated, null, {
      method: result.decision === "AUTO_MERGE" ? best!.method : "NEW_PRODUCT",
      confidence: result.decision === "AUTO_MERGE" ? best!.scoreBp : 10_000,
      evidence: pairEvidence(best),
      auditId,
    });
  }

  private async audit(
    tx: Tx,
    a: {
      subject: "LISTING" | "PRODUCT_PAIR";
      origin: "IMPORT" | "INTERNAL_API" | "DUPLICATE_SCAN" | "REVIEW";
      sourceId?: string | null;
      externalId?: string | null;
      listing?: unknown;
      productAId?: string | null;
      candidateProductId?: string | null;
      candidateVariantId?: string | null;
      resultProductId?: string | null;
      resultVariantId?: string | null;
      scoreBp: number;
      decision:
        | "AUTO_MERGE"
        | "NEW_PRODUCT"
        | "MANUAL_REVIEW"
        | "NO_MATCH"
        | "DUPLICATE_OFFER"
        | "REVIEW_RESOLVED";
      method: string;
      evidence?: unknown;
      conflicts?: unknown;
      reviewOfId?: string | null;
      reviewer?: string | null;
      note?: string | null;
    },
  ): Promise<string> {
    return recordAudit(tx, a, this.engine.config);
  }

  private async upsertReview(
    tx: Tx,
    sourceId: string,
    raw: ValidListing,
    best: PairResult,
    auditId: string,
  ) {
    const data = {
      listing: json(raw),
      candidateProductId: best.productB.id,
      confidence: best.scoreBp,
      method: best.method,
      evidence: pairEvidence(best),
      auditId,
    };
    return tx.productMatchReview.upsert({
      where: { sourceId_externalId: { sourceId, externalId: raw.externalId } },
      create: { sourceId, externalId: raw.externalId, ...data },
      update: { ...data, status: "PENDING", reviewedAt: null, reviewedBy: null, reviewNote: null },
    });
  }

  private async writeOffer(
    tx: Tx,
    sourceId: string,
    index: number,
    listing: NormalizedListing,
    productId: string,
    variant: { id: string; created: boolean },
    productCreated: boolean,
    existing: Prisma.ProductOfferGetPayload<object> | null,
    match: {
      method: string;
      confidence: number;
      evidence: unknown;
      auditId: string | null;
      duplicateOf?: string;
    },
  ): Promise<ListingOutcome> {
    const raw = listing.raw;
    const now = this.now();
    const offerData = {
      productUrl: raw.productUrl,
      canonicalUrl: canonicalUrl(raw.productUrl),
      title: raw.title,
      sellerName: raw.sellerName ?? null,
      mrpPaise: big(raw.mrpPaise),
      sellingPricePaise: BigInt(raw.sellingPricePaise),
      shippingPaise: big(raw.shippingPaise),
      stockStatus: raw.stockStatus,
      currency: raw.currency,
      offerConditions: json(raw.offerConditions),
      sourceUpdatedAt: raw.sourceUpdatedAt ?? null,
      observedAt: now,
    };
    let offerId: string;
    let snapshotCreated = false;
    if (existing) {
      const changed = OFFER_FIELDS_TRACKED.some(
        (f) => String(existing[f] ?? "") !== String(offerData[f] ?? ""),
      );
      offerId = (
        await tx.productOffer.update({
          where: { id: existing.id },
          data: { ...offerData, variantId: variant.id, productId },
        })
      ).id;
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
          matchMethod: match.method as never,
          matchConfidence: match.confidence,
          matchEvidence: json(match.evidence ?? {}),
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
      method: match.method,
      confidence: match.confidence,
      auditId: match.auditId,
      ...(match.duplicateOf ? { duplicateOfOfferId: match.duplicateOf } : {}),
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
    const fingerprintFree = listing.fingerprint
      ? !(await tx.product.findUnique({
          where: { fingerprint: listing.fingerprint },
          select: { id: true },
        }))
      : false;
    const product = await tx.product.create({
      data: {
        name: listing.name,
        normalizedName: listing.normalizedName,
        brand: listing.brand,
        modelNumber: listing.modelNumber,
        fingerprint: fingerprintFree ? listing.fingerprint : null,
        description: raw.description ?? null,
        manufacturer: raw.manufacturer ?? null,
        imageUrl: raw.imageUrl ?? null,
        launchDate: raw.launchDate ?? null,
        specifications: json(raw.specifications),
        categoryId: category?.id ?? null,
      },
    });
    const embedder = this.engine.embeddingProvider;
    if (embedder) {
      const [vector] = await embedder.embed([`${listing.brand} ${listing.name}`]);
      // Best effort: embeddings are optional; the schema exists only with pgvector.
      await storeEmbedding(tx, product.id, embedder.model, vector!).catch(() => undefined);
    }
    return product;
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
    if (Object.keys(additions).length) data.specifications = json({ ...specs, ...additions });
    if (!p.categoryId && raw.categorySlug) {
      const c = await tx.category.findUnique({
        where: { slug: raw.categorySlug },
        select: { id: true },
      });
      if (c) data.category = { connect: { id: c.id } };
    }
    if (Object.keys(data).length) await tx.product.update({ where: { id: productId }, data });
  }

  /** Creates (or reuses, by variant key) a variant; stores the MPN and a free barcode. */
  private async createVariant(
    tx: Tx,
    productId: string,
    listing: NormalizedListing,
  ): Promise<{ id: string; created: boolean }> {
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
      if (!found.mpn && listing.mpnKey) data.mpn = listing.mpnKey;
      if (Object.keys(data).length)
        await tx.productVariant.update({ where: { id: found.id }, data });
      return { id: found.id, created: false };
    }
    const created = await tx.productVariant.create({
      data: {
        productId,
        variantKey: listing.variantKey,
        attributes: json(listing.attributes),
        sku: listing.raw.sku ?? null,
        mpn: listing.mpnKey,
        gtin: barcodeFree ? barcode : null,
      },
    });
    return { id: created.id, created: true };
  }

  /**
   * Resolves a pending listing review — by a HUMAN reviewer only. `match`
   * attaches the listing to a product (variant placed safely, or as the
   * reviewer specifies), `create` makes a new product, `reject` discards it.
   * Records a REVIEW_RESOLVED audit linked to the original decision.
   */
  async resolveReview(
    reviewId: string,
    resolution: ReviewResolution,
    reviewer: Reviewer,
  ): Promise<ListingOutcome | null> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const review = await tx.productMatchReview.findUniqueOrThrow({ where: { id: reviewId } });
        if (review.status !== "PENDING")
          throw new ReviewInputError(`Review ${reviewId} is already ${review.status}`);
        const now = this.now();
        const listing = normalizeListing(sourceListingSchema.parse(review.listing));
        await this.lockBrand(tx, listing.brandKey);
        const originalAudit =
          review.auditId ??
          (await this.audit(tx, {
            subject: "LISTING",
            origin: "REVIEW",
            sourceId: review.sourceId,
            externalId: review.externalId,
            listing: review.listing,
            candidateProductId: review.candidateProductId,
            scoreBp: review.confidence,
            decision: "MANUAL_REVIEW",
            method: review.method,
            evidence: review.evidence,
          }));
        const resolve = async (resultProductId: string | null, resultVariantId: string | null) => {
          await this.audit(tx, {
            subject: "LISTING",
            origin: "REVIEW",
            sourceId: review.sourceId,
            externalId: review.externalId,
            candidateProductId: review.candidateProductId,
            resultProductId,
            resultVariantId,
            scoreBp: resolution.action === "reject" ? 0 : 10_000,
            decision: "REVIEW_RESOLVED",
            method: "MANUAL",
            evidence: { resolution: resolution.action },
            reviewOfId: originalAudit,
            reviewer: reviewer.userId,
            note: reviewer.note ?? null,
          });
          await tx.productMatchReview.update({
            where: { id: reviewId },
            data: {
              status: resolution.action === "reject" ? "REJECTED" : "APPROVED",
              reviewedAt: now,
              reviewedBy: reviewer.userId,
              reviewNote: reviewer.note ?? null,
              auditId: originalAudit,
            },
          });
        };
        if (resolution.action === "reject") {
          await resolve(null, null);
          return null;
        }
        const source = await tx.shoppingSource.findUniqueOrThrow({
          where: { id: review.sourceId },
        });
        if (source.status !== "ACTIVE") throw new SourceNotActiveError(source.slug, source.status);
        let productId: string;
        let variant: { id: string; created: boolean };
        let productCreated = false;
        if (resolution.action === "match") {
          const product = await tx.product.findUnique({
            where: { id: resolution.productId },
            include: productRowInclude,
          });
          if (!product) throw new ReviewInputError("Product not found");
          productId = product.id;
          if (resolution.variantId) {
            if (!product.variants.some((v) => v.id === resolution.variantId)) {
              throw new ReviewInputError("Variant does not belong to the product");
            }
            variant = { id: resolution.variantId, created: false };
          } else {
            const placement = matchVariant(
              listingSubject(listing).variants[0]!,
              productSubject(product).variants,
              listingSubject(listing).profile,
            );
            if (placement.relation === "SAME_VARIANT")
              variant = { id: placement.variantId, created: false };
            else if (placement.relation === "NEW_VARIANT" || resolution.newVariant)
              variant = await this.createVariant(tx, productId, listing);
            else
              throw new ReviewInputError(
                `Variant is ambiguous (${placement.reason}): choose variantId or newVariant`,
              );
          }
        } else {
          productId = (await this.createProduct(tx, listing)).id;
          productCreated = true;
          variant = await this.createVariant(tx, productId, listing);
        }
        await resolve(productId, variant.id);
        const existing = await tx.productOffer.findUnique({
          where: {
            sourceId_externalId: { sourceId: review.sourceId, externalId: review.externalId },
          },
        });
        return this.writeOffer(
          tx,
          review.sourceId,
          0,
          listing,
          productId,
          variant,
          productCreated,
          existing,
          {
            method: resolution.action === "match" ? "MANUAL" : "NEW_PRODUCT",
            confidence: 10_000,
            evidence: { method: "MANUAL", reviewId, reviewer: reviewer.userId },
            auditId: originalAudit,
          },
        );
      },
      { timeout: 20_000 },
    );
    if (outcome?.status === "imported" && this.options.onProductsChanged)
      await this.options.onProductsChanged([outcome.productId]);
    return outcome;
  }
}

/** Appends one audit row (shared by importer, API and review service). */
export async function recordAudit(
  tx: Tx | PrismaClient,
  a: {
    subject: "LISTING" | "PRODUCT_PAIR";
    origin: "IMPORT" | "INTERNAL_API" | "DUPLICATE_SCAN" | "REVIEW";
    sourceId?: string | null;
    externalId?: string | null;
    listing?: unknown;
    productAId?: string | null;
    candidateProductId?: string | null;
    candidateVariantId?: string | null;
    resultProductId?: string | null;
    resultVariantId?: string | null;
    scoreBp: number;
    decision:
      | "AUTO_MERGE"
      | "NEW_PRODUCT"
      | "MANUAL_REVIEW"
      | "NO_MATCH"
      | "DUPLICATE_OFFER"
      | "REVIEW_RESOLVED";
    method: string;
    evidence?: unknown;
    conflicts?: unknown;
    reviewOfId?: string | null;
    reviewer?: string | null;
    note?: string | null;
  },
  config: MatchingConfig = DEFAULT_MATCHING_CONFIG,
): Promise<string> {
  const row = await tx.productMatchAudit.create({
    data: {
      subject: a.subject,
      origin: a.origin,
      sourceId: a.sourceId ?? null,
      externalId: a.externalId ?? null,
      ...(a.listing !== undefined ? { listing: json(a.listing) } : {}),
      productAId: a.productAId ?? null,
      candidateProductId: a.candidateProductId ?? null,
      candidateVariantId: a.candidateVariantId ?? null,
      resultProductId: a.resultProductId ?? null,
      resultVariantId: a.resultVariantId ?? null,
      scoreBp: Math.max(0, Math.min(10_000, Math.round(a.scoreBp))),
      // Same thresholds as the engine that produced the score.
      confidence: confidenceOf(a.scoreBp, config),
      decision: a.decision,
      method: a.method as never,
      evidence: json(a.evidence ?? {}),
      conflicts: json(a.conflicts ?? []),
      engineVersion: ENGINE_VERSION,
      reviewOfId: a.reviewOfId ?? null,
      reviewer: a.reviewer ?? null,
      note: a.note ?? null,
    },
    select: { id: true },
  });
  return row.id;
}
