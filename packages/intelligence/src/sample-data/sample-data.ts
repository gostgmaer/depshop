/**
 * DEVELOPMENT SAMPLE DATA — NOT REAL OFFERS.
 *
 * Gives local developers something to browse. Every offer belongs to the
 * fictional store "DealMind Sample Store" (`isSample = true`, example.com URLs)
 * and every price/MRP below is made up. APIs flag these offers
 * (`source.isSample`, `sampleData`) so clients must label them as sample data.
 *
 * Products are well-known models named only by brand, product line and the
 * storage/RAM/colour options they are sold in. No specifications, model
 * numbers, barcodes or launch dates are included, because none were taken
 * from an authoritative source.
 *
 * Seeding goes through the normal importer (validation, normalization,
 * matching, variants, offers, price history), so it also exercises that path.
 * Refuses to run when NODE_ENV=production.
 */
import type { PrismaClient } from "@dealmind/db";
import { CatalogImporter, type ImportSummary } from "../matching/deduplication/importer.js";
import type { SourceListing } from "@dealmind/catalog";

export const SAMPLE_SOURCE = {
  slug: "dealmind_sample",
  name: "DealMind Sample Store (sample data — not a real store)",
  domain: "example.com",
  baseUrl: "https://sample.example.com",
} as const;

interface SampleProduct {
  key: string;
  brand: string;
  line: string;
  categorySlug: string;
  /** One entry per variant actually sold; `price`/`mrp` are made-up rupees. */
  variants: { label: string; attributes: Record<string, string>; price: number; mrp: number }[];
}

const SAMPLE_PRODUCTS: SampleProduct[] = [
  {
    key: "iphone-15",
    brand: "Apple",
    line: "iPhone 15",
    categorySlug: "smartphones",
    variants: [
      {
        label: "128 GB - Black",
        attributes: { color: "Black", storage: "128 GB" },
        price: 69_900,
        mrp: 79_900,
      },
      {
        label: "256 GB - Blue",
        attributes: { color: "Blue", storage: "256 GB" },
        price: 79_900,
        mrp: 89_900,
      },
      {
        label: "512 GB - Pink",
        attributes: { color: "Pink", storage: "512 GB" },
        price: 99_900,
        mrp: 1_09_900,
      },
    ],
  },
  {
    key: "oneplus-12",
    brand: "OnePlus",
    line: "OnePlus 12",
    categorySlug: "smartphones",
    variants: [
      {
        label: "Flowy Emerald, 12GB RAM, 256GB Storage",
        attributes: { color: "Flowy Emerald", ram: "12 GB", storage: "256 GB" },
        price: 59_999,
        mrp: 64_999,
      },
      {
        label: "Silky Black, 16GB RAM, 512GB Storage",
        attributes: { color: "Silky Black", ram: "16 GB", storage: "512 GB" },
        price: 66_999,
        mrp: 69_999,
      },
    ],
  },
  {
    key: "galaxy-s24",
    brand: "Samsung",
    line: "Galaxy S24 5G",
    categorySlug: "smartphones",
    variants: [
      {
        label: "Onyx Black, 8GB RAM, 256GB Storage",
        attributes: { color: "Onyx Black", ram: "8 GB", storage: "256 GB" },
        price: 74_999,
        mrp: 89_999,
      },
    ],
  },
  {
    key: "macbook-air-m2",
    brand: "Apple",
    line: "MacBook Air 13-inch M2",
    categorySlug: "laptops",
    variants: [
      {
        label: "Midnight, 8GB RAM, 256GB SSD",
        attributes: { color: "Midnight", ram: "8 GB", storage: "256 GB" },
        price: 89_990,
        mrp: 99_900,
      },
    ],
  },
  {
    key: "ipad-10",
    brand: "Apple",
    line: "iPad (10th generation) Wi-Fi",
    categorySlug: "tablets",
    variants: [
      {
        label: "64 GB - Silver",
        attributes: { color: "Silver", storage: "64 GB" },
        price: 34_900,
        mrp: 39_900,
      },
      {
        label: "256 GB - Blue",
        attributes: { color: "Blue", storage: "256 GB" },
        price: 49_900,
        mrp: 54_900,
      },
    ],
  },
  {
    key: "wh-1000xm5",
    brand: "Sony",
    line: "WH-1000XM5 Wireless Noise Cancelling Headphones",
    categorySlug: "audio",
    variants: [
      { label: "Black", attributes: { color: "Black" }, price: 26_990, mrp: 34_990 },
      { label: "Silver", attributes: { color: "Silver" }, price: 27_490, mrp: 34_990 },
    ],
  },
  {
    key: "levis-511",
    brand: "Levi's",
    line: "Men's 511 Slim Fit Jeans",
    categorySlug: "mens-clothing",
    variants: [
      { label: "Size 32", attributes: { size: "32" }, price: 1_999, mrp: 3_599 },
      { label: "Size 34", attributes: { size: "34" }, price: 1_999, mrp: 3_599 },
    ],
  },
];

/** Builds the sample listings (made-up prices in paise, example.com URLs). */
export function sampleListings(): SourceListing[] {
  return SAMPLE_PRODUCTS.flatMap((p) =>
    p.variants.map((v, i) => ({
      externalId: `sample-${p.key}-${i + 1}`,
      title: `${p.brand} ${p.line} (${v.label})`.replace(`${p.brand} ${p.brand} `, `${p.brand} `),
      productUrl: `${SAMPLE_SOURCE.baseUrl}/p/${p.key}-${i + 1}`,
      brand: p.brand,
      categorySlug: p.categorySlug,
      attributes: v.attributes,
      sellingPricePaise: v.price * 100,
      mrpPaise: v.mrp * 100,
      stockStatus: "IN_STOCK" as const,
      sellerName: "Sample Seller (not real)",
      offerConditions: { sampleData: true },
    })),
  );
}

export async function seedSampleCatalog(
  prisma: PrismaClient,
  options: { env?: string; onProductsChanged?: (ids: string[]) => Promise<void> | void } = {},
): Promise<ImportSummary> {
  if ((options.env ?? process.env.NODE_ENV) === "production") {
    throw new Error("Refusing to seed sample catalog data in production");
  }
  await prisma.shoppingSource.upsert({
    where: { slug: SAMPLE_SOURCE.slug },
    create: {
      ...SAMPLE_SOURCE,
      integrationKind: "PARTNER",
      status: "ACTIVE",
      isSample: true,
      capabilities: { sampleData: true },
    },
    // Keep it flagged as sample whatever else an admin changed.
    update: { isSample: true, domain: SAMPLE_SOURCE.domain, baseUrl: SAMPLE_SOURCE.baseUrl },
  });
  const importer = new CatalogImporter(prisma, {
    ...(options.onProductsChanged ? { onProductsChanged: options.onProductsChanged } : {}),
  });
  return importer.importListings(SAMPLE_SOURCE.slug, sampleListings());
}
