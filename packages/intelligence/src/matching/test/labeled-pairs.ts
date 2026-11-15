/**
 * LABELLED TEST DATASET for matching accuracy (test data only — not catalog data).
 * Titles imitate how Indian marketplaces write listings. No prices, URLs or
 * claims; identifiers are synthetic test values with valid check digits.
 *
 * Labels:
 *   SAME_VARIANT      — the same sellable item (same configuration)
 *   SAME_PRODUCT      — the same product, a different variant (RAM/storage/colour/size)
 *   DIFFERENT_PRODUCT — must never be merged
 */
export type PairLabel = "SAME_VARIANT" | "SAME_PRODUCT" | "DIFFERENT_PRODUCT";

export interface Side {
  title: string;
  brand: string;
  model?: string;
  mpn?: string;
  barcode?: string;
  attributes?: Record<string, string>;
}

export interface LabeledPair {
  id: string;
  category: string;
  label: PairLabel;
  a: Side;
  b: Side;
  note: string;
}

const S = (title: string, brand: string, extra: Partial<Side> = {}): Side => ({
  title,
  brand,
  ...extra,
});

export const LABELED_PAIRS: LabeledPair[] = [
  // ── Smartphones ─────────────────────────────────────────────────────────
  {
    id: "p01",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "spec example: Navy vs Blue (colour family only) → needs validation",
    a: S("Samsung Galaxy S25 5G, 12GB RAM, 256GB, Navy", "Samsung"),
    b: S("Samsung S25 5G Smartphone, 256 GB, 12 GB RAM, Blue", "Samsung"),
  },
  {
    id: "p02",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "same item, different word order",
    a: S("Apple iPhone 15 (128 GB) - Black", "Apple"),
    b: S("Apple iPhone 15 (Black, 128 GB)", "Apple"),
  },
  {
    id: "p03",
    category: "smartphones",
    label: "SAME_PRODUCT",
    note: "storage differs",
    a: S("Apple iPhone 15 (128 GB) - Black", "Apple"),
    b: S("Apple iPhone 15 (256 GB) - Black", "Apple"),
  },
  {
    id: "p04",
    category: "smartphones",
    label: "SAME_PRODUCT",
    note: "colour differs",
    a: S("Apple iPhone 15 (128 GB) - Black", "Apple"),
    b: S("Apple iPhone 15 (128 GB) - Pink", "Apple"),
  },
  {
    id: "p05",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "Plus line",
    a: S("Apple iPhone 15 (128 GB) - Black", "Apple"),
    b: S("Apple iPhone 15 Plus (128 GB) - Black", "Apple"),
  },
  {
    id: "p06",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "Pro Max line",
    a: S("Apple iPhone 15 Pro (256 GB) - Natural Titanium", "Apple"),
    b: S("Apple iPhone 15 Pro Max (256 GB) - Natural Titanium", "Apple"),
  },
  {
    id: "p07",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "generation",
    a: S("Apple iPhone 15 (128 GB) - Black", "Apple"),
    b: S("Apple iPhone 14 (128 GB) - Black", "Apple"),
  },
  {
    id: "p08",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "S25 vs S25+ ('+' must not vanish)",
    a: S("Samsung Galaxy S25 5G (Navy, 12GB RAM, 256GB Storage)", "Samsung"),
    b: S("Samsung Galaxy S25+ 5G (Navy, 12GB RAM, 256GB Storage)", "Samsung"),
  },
  {
    id: "p09",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "Ultra line",
    a: S("Samsung Galaxy S25 5G (Navy, 12GB RAM, 256GB Storage)", "Samsung"),
    b: S("Samsung Galaxy S25 Ultra 5G (Titanium Black, 12GB RAM, 256GB Storage)", "Samsung"),
  },
  {
    id: "p10",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "S24 vs S24 FE",
    a: S("Samsung Galaxy S24 5G (Onyx Black, 8GB RAM, 256GB Storage)", "Samsung"),
    b: S("Samsung Galaxy S24 FE 5G (Blue, 8GB RAM, 256GB Storage)", "Samsung"),
  },
  {
    id: "p11",
    category: "smartphones",
    label: "SAME_PRODUCT",
    note: "RAM + storage differ",
    a: S("OnePlus 12 (Flowy Emerald, 12GB RAM, 256GB Storage)", "OnePlus"),
    b: S("OnePlus 12 (Flowy Emerald, 16GB RAM, 512GB Storage)", "OnePlus"),
  },
  {
    id: "p12",
    category: "smartphones",
    label: "SAME_PRODUCT",
    note: "RAM only differs",
    a: S("Redmi Note 13 5G (Arctic White, 6GB RAM, 128GB Storage)", "Redmi"),
    b: S("Redmi Note 13 5G (Arctic White, 8GB RAM, 128GB Storage)", "Redmi"),
  },
  {
    id: "p13",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "Pro vs base",
    a: S("Redmi Note 13 Pro 5G (Arctic White, 8GB RAM, 256GB Storage)", "Redmi"),
    b: S("Redmi Note 13 5G (Arctic White, 8GB RAM, 256GB Storage)", "Redmi"),
  },
  {
    id: "p14",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "Pro+ vs Pro",
    a: S("Redmi Note 13 Pro+ 5G (Fusion Purple, 12GB RAM, 256GB Storage)", "Redmi"),
    b: S("Redmi Note 13 Pro 5G (Fusion Purple, 12GB RAM, 256GB Storage)", "Redmi"),
  },
  {
    id: "p15",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "same model number, different wording",
    a: S("Samsung Galaxy S25 5G SM-S931B (Icyblue, 12GB RAM, 256GB Storage)", "Samsung", {
      model: "SM-S931B",
    }),
    b: S("Samsung S25 Smartphone 256GB Storage 12GB RAM Icyblue", "Samsung", { model: "SM-S931B" }),
  },
  {
    id: "p16",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "different model numbers (S25 vs S25+)",
    a: S("Samsung Galaxy 5G (Navy, 12GB RAM, 256GB Storage)", "Samsung", { model: "SM-S931B" }),
    b: S("Samsung Galaxy 5G (Navy, 12GB RAM, 256GB Storage)", "Samsung", { model: "SM-S936B" }),
  },
  {
    id: "p17",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "same barcode, different titles",
    a: S("Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)", "Acme", {
      barcode: "8901234567897",
    }),
    b: S("ACME NOVA-7 5G Smartphone 8GB 128GB Black", "Acme", { barcode: "8901234567897" }),
  },
  {
    id: "p18",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "same MPN",
    a: S("Samsung Galaxy S25 5G (Navy, 12GB, 256GB)", "Samsung", { mpn: "SM-S931BZBCINS" }),
    b: S("Samsung Galaxy S25 Navy 256 GB", "Samsung", { mpn: "SM-S931BZBC-INS" }),
  },
  {
    id: "p19",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "same title, different brand",
    a: S("Nova 7 5G (Black, 8GB RAM, 128GB Storage)", "Acme"),
    b: S("Nova 7 5G (Black, 8GB RAM, 128GB Storage)", "Zenith"),
  },
  {
    id: "p20",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "Space Gray / Space Grey spelling",
    a: S("Apple iPad (10th generation) Wi-Fi (64 GB) - Space Gray", "Apple"),
    b: S("Apple iPad (10th generation) Wi-Fi (64 GB) - Space Grey", "Apple"),
  },
  {
    id: "p21",
    category: "smartphones",
    label: "SAME_VARIANT",
    note: "colour words in a different order",
    a: S("Apple iPhone 15 Pro (256 GB) - Blue Titanium", "Apple"),
    b: S("Apple iPhone 15 Pro (256 GB) - Titanium Blue", "Apple"),
  },
  {
    id: "p22",
    category: "smartphones",
    label: "DIFFERENT_PRODUCT",
    note: "4G vs 5G edition",
    a: S("Samsung Galaxy A15 5G (Blue Black, 8GB RAM, 128GB Storage)", "Samsung"),
    b: S("Samsung Galaxy A15 4G (Blue Black, 8GB RAM, 128GB Storage)", "Samsung"),
  },
  {
    id: "p23",
    category: "smartphones",
    label: "SAME_PRODUCT",
    note: "Midnight vs Starlight colours",
    a: S("Apple iPhone 13 (128 GB) - Midnight", "Apple"),
    b: S("Apple iPhone 13 (128 GB) - Starlight", "Apple"),
  },

  // ── Laptops ─────────────────────────────────────────────────────────────
  {
    id: "l01",
    category: "laptops",
    label: "SAME_VARIANT",
    note: "same config, two wordings",
    a: S(
      "HP Pavilion 15 Intel Core i5 13th Gen 1335U (16GB RAM, 512GB SSD) 15.6 inch FHD Laptop",
      "HP",
    ),
    b: S(
      "HP Pavilion 15 Laptop 13th Gen Intel Core i5-1335U 16GB RAM 512GB SSD 15.6 inch FHD",
      "HP",
    ),
  },
  {
    id: "l02",
    category: "laptops",
    label: "DIFFERENT_PRODUCT",
    note: "i5 vs i7",
    a: S("HP Pavilion 15 Intel Core i5 13th Gen 1335U (16GB RAM, 512GB SSD) 15.6 inch FHD", "HP"),
    b: S("HP Pavilion 15 Intel Core i7 13th Gen 1355U (16GB RAM, 512GB SSD) 15.6 inch FHD", "HP"),
  },
  {
    id: "l03",
    category: "laptops",
    label: "SAME_PRODUCT",
    note: "SSD size differs",
    a: S("Lenovo IdeaPad Slim 3 AMD Ryzen 5 7530U (16GB RAM, 512GB SSD) 15.6 inch FHD", "Lenovo"),
    b: S("Lenovo IdeaPad Slim 3 AMD Ryzen 5 7530U (16GB RAM, 1TB SSD) 15.6 inch FHD", "Lenovo"),
  },
  {
    id: "l04",
    category: "laptops",
    label: "DIFFERENT_PRODUCT",
    note: "GPU differs",
    a: S(
      "ASUS TUF Gaming F15 Intel Core i5 12500H RTX 4050 (16GB RAM, 512GB SSD) 15.6 inch",
      "ASUS",
    ),
    b: S(
      "ASUS TUF Gaming F15 Intel Core i5 12500H RTX 3050 (16GB RAM, 512GB SSD) 15.6 inch",
      "ASUS",
    ),
  },
  {
    id: "l05",
    category: "laptops",
    label: "DIFFERENT_PRODUCT",
    note: "M2 vs M3 chip",
    a: S("Apple MacBook Air 13-inch M2 chip (8GB RAM, 256GB SSD) - Midnight", "Apple"),
    b: S("Apple MacBook Air 13-inch M3 chip (8GB RAM, 256GB SSD) - Midnight", "Apple"),
  },
  {
    id: "l06",
    category: "laptops",
    label: "DIFFERENT_PRODUCT",
    note: "14 vs 16 inch",
    a: S("Apple MacBook Pro 14-inch M3 Pro chip (18GB RAM, 512GB SSD) - Space Black", "Apple"),
    b: S("Apple MacBook Pro 16-inch M3 Pro chip (18GB RAM, 512GB SSD) - Space Black", "Apple"),
  },
  {
    id: "l07",
    category: "laptops",
    label: "DIFFERENT_PRODUCT",
    note: "model year",
    a: S("Dell Inspiron 3520 Intel Core i5 (8GB RAM, 512GB SSD) 15.6 inch (2023)", "Dell"),
    b: S("Dell Inspiron 3520 Intel Core i5 (8GB RAM, 512GB SSD) 15.6 inch (2024)", "Dell"),
  },

  // ── Televisions ─────────────────────────────────────────────────────────
  {
    id: "t01",
    category: "televisions",
    label: "SAME_VARIANT",
    note: "same model number",
    a: S(
      "Samsung 138 cm (55 inches) Crystal 4K Vivid Ultra HD Smart LED TV UA55DUE77AKLXL",
      "Samsung",
      { model: "UA55DUE77AKLXL" },
    ),
    b: S("Samsung Crystal 4K Vivid 55 inch Ultra HD LED Smart TV (UA55DUE77AKLXL)", "Samsung", {
      model: "UA55DUE77AKLXL",
    }),
  },
  {
    id: "t02",
    category: "televisions",
    label: "DIFFERENT_PRODUCT",
    note: "screen size",
    a: S("Samsung Crystal 4K Vivid 55 inch Ultra HD Smart LED TV", "Samsung"),
    b: S("Samsung Crystal 4K Vivid 65 inch Ultra HD Smart LED TV", "Samsung"),
  },
  {
    id: "t03",
    category: "televisions",
    label: "DIFFERENT_PRODUCT",
    note: "resolution",
    a: S("Acme Vision 43 inch 4K Ultra HD Smart LED TV", "Acme"),
    b: S("Acme Vision 43 inch Full HD Smart LED TV", "Acme"),
  },
  {
    id: "t04",
    category: "televisions",
    label: "DIFFERENT_PRODUCT",
    note: "panel",
    a: S("Acme Vision 55 inch 4K QLED Smart TV", "Acme"),
    b: S("Acme Vision 55 inch 4K LED Smart TV", "Acme"),
  },
  {
    id: "t05",
    category: "televisions",
    label: "SAME_VARIANT",
    note: "cm vs inch wording",
    a: S("Zenith Vision 139 cm (55 inch) 4K Ultra HD Smart LED TV", "Zenith"),
    b: S("Zenith Vision 55 inch 4K UHD Smart LED TV", "Zenith"),
  },

  // ── Appliances ──────────────────────────────────────────────────────────
  {
    id: "a01",
    category: "washing-machines",
    label: "DIFFERENT_PRODUCT",
    note: "drum capacity",
    a: S("LG 7 kg 5 Star Inverter Fully-Automatic Front Load Washing Machine", "LG"),
    b: S("LG 8 kg 5 Star Inverter Fully-Automatic Front Load Washing Machine", "LG"),
  },
  {
    id: "a02",
    category: "air-conditioners",
    label: "DIFFERENT_PRODUCT",
    note: "energy rating",
    a: S("Voltas 1.5 Ton 3 Star Inverter Split AC", "Voltas"),
    b: S("Voltas 1.5 Ton 5 Star Inverter Split AC", "Voltas"),
  },
  {
    id: "a03",
    category: "air-conditioners",
    label: "DIFFERENT_PRODUCT",
    note: "tonnage",
    a: S("Voltas 1 Ton 3 Star Inverter Split AC", "Voltas"),
    b: S("Voltas 1.5 Ton 3 Star Inverter Split AC", "Voltas"),
  },
  {
    id: "a04",
    category: "air-conditioners",
    label: "SAME_VARIANT",
    note: "same model number",
    a: S("Daikin 1.5 Ton 3 Star Inverter Split AC FTKL50UV16V", "Daikin", { model: "FTKL50UV16V" }),
    b: S("Daikin FTKL50UV16V 1.5 Ton 3 Star Split Inverter AC (Copper Condenser)", "Daikin", {
      model: "FTKL50UV16V",
    }),
  },
  {
    id: "a05",
    category: "refrigerators",
    label: "DIFFERENT_PRODUCT",
    note: "litres",
    a: S("Whirlpool 253 L 3 Star Frost Free Double Door Refrigerator", "Whirlpool"),
    b: S("Whirlpool 236 L 3 Star Frost Free Double Door Refrigerator", "Whirlpool"),
  },

  // ── Fashion / accessories ───────────────────────────────────────────────
  {
    id: "f01",
    category: "mens-clothing",
    label: "SAME_PRODUCT",
    note: "size differs",
    a: S("Levi's Men's 511 Slim Fit Jeans (Size 32)", "Levi's", { attributes: { size: "32" } }),
    b: S("Levi's Men's 511 Slim Fit Jeans (Size 34)", "Levi's", { attributes: { size: "34" } }),
  },
  {
    id: "f02",
    category: "mens-clothing",
    label: "SAME_VARIANT",
    note: "same size and colour",
    a: S("Levi's Men's 511 Slim Fit Jeans (Size 32, Dark Indigo)", "Levi's", {
      attributes: { size: "32", color: "Dark Indigo" },
    }),
    b: S("Levi's Men's 511 Slim Fit Jeans Dark Indigo", "Levi's", {
      attributes: { size: "32", color: "Dark Indigo" },
    }),
  },
  {
    id: "x01",
    category: "audio",
    label: "DIFFERENT_PRODUCT",
    note: "model token differs",
    a: S("boAt Airdopes 141 TWS Earbuds", "boAt"),
    b: S("boAt Airdopes 161 TWS Earbuds", "boAt"),
  },
  {
    id: "x02",
    category: "audio",
    label: "DIFFERENT_PRODUCT",
    note: "XM5 vs XM4",
    a: S("Sony WH-1000XM5 Wireless Noise Cancelling Headphones (Black)", "Sony"),
    b: S("Sony WH-1000XM4 Wireless Noise Cancelling Headphones (Black)", "Sony"),
  },
  {
    id: "x03",
    category: "wearables",
    label: "DIFFERENT_PRODUCT",
    note: "case size",
    a: S("Apple Watch Series 9 GPS 41mm Midnight Aluminium Case", "Apple"),
    b: S("Apple Watch Series 9 GPS 45mm Midnight Aluminium Case", "Apple"),
  },
  {
    id: "x04",
    category: "audio",
    label: "SAME_VARIANT",
    note: "identical listing",
    a: S("Sony WH-1000XM5 Wireless Noise Cancelling Headphones (Black)", "Sony"),
    b: S("Sony WH-1000XM5 Wireless Noise Cancelling Headphones (Black)", "Sony"),
  },
];
