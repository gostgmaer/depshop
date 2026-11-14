import { describe, expect, it } from "vitest";
import { normalizeListing, sourceListingSchema } from "./listing.js";
import {
  analyzeTitle,
  canonicalAttributes,
  classifyBarcode,
  discriminatorConflicts,
  identifierForms,
  modelKey,
  normalizeBrand,
  normalizeColour,
  normalizeText,
  parseCapacityGb,
  parseMemoryFromTitle,
  productDisplayName,
  type VariantAttributes,
  variantKeyOf,
} from "./normalize.js";

describe("text and brand normalization", () => {
  it("normalizes text deterministically", () => {
    expect(normalizeText("  Samsung  Galaxy S24 (Onyx-Black) ")).toBe(
      "samsung galaxy s24 onyx black",
    );
    expect(normalizeText("Levi's 511™ Slim & Fit")).toBe("levis 511 slim and fit");
    expect(normalizeText("1.5 Ton 5 Star Inverter.")).toBe("1.5 ton 5 star inverter");
  });

  it("maps brand aliases to one canonical brand and keeps unknown brands as published", () => {
    expect(normalizeBrand("MI")).toBe("Xiaomi");
    expect(normalizeBrand("Samsung Electronics")).toBe("Samsung");
    expect(normalizeBrand("One Plus")).toBe("OnePlus");
    expect(normalizeBrand("Hewlett-Packard")).toBe("HP");
    expect(normalizeBrand("Redmi")).toBe("Redmi"); // sub-brand stays separate
    expect(normalizeBrand("  Acme   Gadgets ")).toBe("Acme Gadgets");
  });

  it("canonicalizes model numbers", () => {
    expect(modelKey("SM-S921B/DS")).toBe("SMS921BDS");
    expect(modelKey("sm s921b ds")).toBe("SMS921BDS");
    expect(modelKey("-")).toBeNull();
  });
});

describe("identifiers", () => {
  it("validates barcode check digits and files them by length", () => {
    expect(classifyBarcode("4006381333931")).toEqual({ ean: "4006381333931" });
    expect(classifyBarcode("036000291452")).toEqual({ upc: "036000291452" });
    expect(classifyBarcode("96385074")).toEqual({ gtin: "96385074" });
    expect(classifyBarcode("4006381333932")).toEqual({}); // bad check digit
    expect(classifyBarcode("ABC")).toEqual({});
  });

  it("treats UPC-A and its EAN-13/GTIN-14 forms as the same identifier", () => {
    const forms = identifierForms({ upc: "036000291452" });
    expect(forms.ean).toContain("0036000291452");
    expect(forms.gtin).toContain("00036000291452");
    expect(identifierForms({ ean: "0036000291452" }).upc).toContain("036000291452");
  });
});

describe("units, colours and variant attributes", () => {
  it("parses capacities to GB", () => {
    expect(parseCapacityGb("8 GB")).toBe(8);
    expect(parseCapacityGb("1TB")).toBe(1024);
    expect(parseCapacityGb("512 MB")).toBe(0.5);
    expect(parseCapacityGb("large")).toBeNull();
  });

  it("parses RAM and storage only from explicit title patterns", () => {
    expect(parseMemoryFromTitle("Phone (8GB RAM, 256GB Storage)")).toEqual({
      ram_gb: 8,
      storage_gb: 256,
    });
    expect(parseMemoryFromTitle("Phone (Black, 8GB+128GB)")).toEqual({
      ram_gb: 8,
      storage_gb: 128,
    });
    expect(parseMemoryFromTitle("Laptop 16 GB DDR5 RAM 1 TB SSD")).toEqual({
      ram_gb: 16,
      storage_gb: 1024,
    });
    // A lone capacity is ambiguous: not assigned to RAM or storage.
    expect(parseMemoryFromTitle("Phone 128 GB")).toEqual({});
  });

  it("keeps the published colour name and derives a family", () => {
    expect(normalizeColour("Titanium Blue")).toEqual({
      name: "Titanium Blue",
      key: "titanium-blue",
      family: "blue",
    });
    expect(normalizeColour("Midnight")).toMatchObject({ family: "black" });
    expect(normalizeColour("Cosmic Sparkle")).toMatchObject({ family: null });
  });

  it("builds canonical attributes (provided values win) and a stable variant key", () => {
    const a = canonicalAttributes("Phone (8GB RAM, 128GB Storage)", {
      Colour: "Onyx Black",
      Storage: "256 GB",
    });
    expect(a).toEqual({ ram_gb: 8, storage_gb: 256, color: "Onyx Black", color_family: "black" });
    expect(variantKeyOf(a)).toBe("color=onyx-black|ram_gb=8|storage_gb=256");
    expect(variantKeyOf({ storage_gb: 256, ram_gb: 8, color: "Onyx Black" })).toBe(variantKeyOf(a));
    expect(variantKeyOf({})).toBe("default");
  });

  it("never gives different RAM, storage or capacity the same variant key", () => {
    const sets: VariantAttributes[] = [
      { ram_gb: 8, storage_gb: 128 },
      { ram_gb: 12, storage_gb: 128 },
      { ram_gb: 8, storage_gb: 256 },
      { capacity_l: 253 },
      { capacity_l: 300 },
      { capacity_kg: 7 },
    ];
    const keys = sets.map((a) => variantKeyOf(a));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("title analysis", () => {
  it("gives variants of one product the same normalized name", () => {
    const a = analyzeTitle("Samsung Galaxy S24 5G (Onyx Black, 8GB RAM, 256GB Storage)", "Samsung");
    const b = analyzeTitle("Samsung Galaxy S24 5G (Marble Grey, 8GB, 128GB)", "Samsung");
    expect(a.normalizedName).toBe("samsung galaxy s24 5g");
    expect(b.normalizedName).toBe(a.normalizedName);
    expect(a.discriminators).toEqual(["5g", "s24"]);
  });

  it("keeps generations and line qualifiers as discriminators", () => {
    const base = analyzeTitle("Apple iPhone 15 (128 GB) - Black", "Apple");
    const pro = analyzeTitle("Apple iPhone 15 Pro (128 GB) - Black Titanium", "Apple");
    const older = analyzeTitle("Apple iPhone 14 (128 GB) - Midnight", "Apple");
    expect(discriminatorConflicts(base.discriminators, pro.discriminators)).toEqual(["pro"]);
    expect(discriminatorConflicts(base.discriminators, older.discriminators)).toEqual(["14", "15"]);
  });

  it("strips the variant parenthetical from display names only", () => {
    expect(productDisplayName("Samsung Galaxy S24 5G (Onyx Black, 8GB, 256GB)")).toBe(
      "Samsung Galaxy S24 5G",
    );
    expect(productDisplayName("Sony WH-1000XM5 (Wireless)")).toBe("Sony WH-1000XM5 (Wireless)");
  });
});

describe("listing validation and normalization", () => {
  const valid = {
    externalId: "B0TEST",
    title: "Mi Redmi Note 13 5G (Arctic White, 8GB RAM, 256GB Storage)",
    productUrl: "https://www.example.com/p/B0TEST",
    brand: "Redmi",
    modelNumber: "2312DRA50I",
    barcode: "4006381333931",
    sellingPricePaise: 1_999_900,
    mrpPaise: 2_499_900,
  };

  it("normalizes a listing without inventing data", () => {
    const n = normalizeListing(sourceListingSchema.parse(valid));
    expect(n).toMatchObject({
      brand: "Redmi",
      fingerprint: "redmi:2312DRA50I",
      identifiers: { ean: "4006381333931" },
      attributes: { ram_gb: 8, storage_gb: 256 },
      variantKey: "ram_gb=8|storage_gb=256",
    });
    expect(n.raw.stockStatus).toBe("UNKNOWN"); // not provided → unknown, never assumed
    expect(n.raw.specifications).toEqual({});
  });

  it("rejects invalid listings", () => {
    const bad = [
      { ...valid, sellingPricePaise: -1 },
      { ...valid, sellingPricePaise: 19.99 },
      { ...valid, productUrl: "javascript:alert(1)" },
      { ...valid, currency: "USD" },
      { ...valid, title: "" },
      { ...valid, userId: "x" }, // unknown keys rejected
      { ...valid, externalId: undefined },
    ];
    for (const b of bad)
      expect(sourceListingSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});

describe("display names", () => {
  it("removes variant descriptors wherever marketplaces put them", () => {
    expect(productDisplayName("Apple iPhone 15 (128 GB) - Black")).toBe("Apple iPhone 15");
    expect(productDisplayName("OnePlus 12 (Flowy Emerald, 16GB RAM, 512GB Storage)")).toBe(
      "OnePlus 12",
    );
    expect(productDisplayName("Sony WH-1000XM5 Wireless Headphones (Silver)")).toBe(
      "Sony WH-1000XM5 Wireless Headphones",
    );
    expect(productDisplayName("Levi's 511 Slim Fit Jeans")).toBe("Levi's 511 Slim Fit Jeans");
    expect(productDisplayName("Levi's 511 Slim Fit Jeans (Size 32)")).toBe(
      "Levi's 511 Slim Fit Jeans",
    );
    expect(productDisplayName("Sony WH-1000XM5 (Wireless)")).toBe("Sony WH-1000XM5 (Wireless)");
  });
});
