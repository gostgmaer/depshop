/**
 * MOCK CONNECTORS — local development and tests only.
 *
 * They return a small fixed set of FICTIONAL products (brands "Acme",
 * "Zenith", "Orbit"; example.com URLs; made-up prices). Every item carries
 * provenance `MOCK`, the source rows are flagged `isSample`, and the executor
 * refuses to run mock connectors unless explicitly allowed (never in production).
 */
import type {
  ConnectorCallContext,
  DealFeedPage,
  DealFeedRequest,
  ShoppingConnector,
} from "../core/interfaces/connector.js";
import { sleep } from "../core/retry/retry.js";
import { ConnectorError } from "../core/types/errors.js";
import type {
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorReadiness,
  ConnectorSearchResultInput,
  NormalizedProductInput,
  ValidSearchRequest,
} from "../core/types/schemas.js";

interface Fixture {
  sku: string;
  title: string;
  brand: string;
  category: string;
  /** Made-up rupees. */
  price: number;
  mrp: number;
  variant: Record<string, string>;
}

/** Fictional catalogue shared by the mock stores (prices differ per store). */
export const MOCK_FIXTURES: Fixture[] = [
  {
    sku: "acme-nova7-128",
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    brand: "Acme",
    category: "smartphones",
    price: 18_999,
    mrp: 24_999,
    variant: { color: "Midnight Black", ram: "8 GB", storage: "128 GB" },
  },
  {
    sku: "acme-nova7-256",
    title: "Acme Nova 7 5G (Glacier Blue, 8GB RAM, 256GB Storage)",
    brand: "Acme",
    category: "smartphones",
    price: 20_999,
    mrp: 26_999,
    variant: { color: "Glacier Blue", ram: "8 GB", storage: "256 GB" },
  },
  {
    sku: "zenith-x2-laptop",
    title: "Zenith X2 Laptop 14 inch (16GB RAM, 512GB SSD)",
    brand: "Zenith",
    category: "laptops",
    price: 54_990,
    mrp: 64_990,
    variant: { ram: "16 GB", storage: "512 GB" },
  },
  {
    sku: "orbit-run-shoe-9",
    title: "Orbit Stride Running Shoes (Size 9)",
    brand: "Orbit",
    category: "footwear",
    price: 2_499,
    mrp: 3_999,
    variant: { size: "9" },
  },
  {
    sku: "orbit-run-shoe-10",
    title: "Orbit Stride Running Shoes (Size 10)",
    brand: "Orbit",
    category: "footwear",
    price: 2_499,
    mrp: 3_999,
    variant: { size: "10" },
  },
  {
    sku: "acme-mixer-750",
    title: "Acme PowerMix 750W Mixer Grinder",
    brand: "Acme",
    category: "kitchen-appliances",
    price: 3_299,
    mrp: 4_999,
    variant: {},
  },
  {
    sku: "zenith-tv-55",
    title: "Zenith Vision 55 inch 4K Smart TV",
    brand: "Zenith",
    category: "televisions",
    price: 38_990,
    mrp: 49_990,
    variant: {},
  },
];

const STOP = new Set(["the", "a", "an", "for", "with", "and", "under", "best", "buy"]);

export interface MockConnectorOptions {
  id: string;
  name: string;
  /** Price multiplier in basis points so mock stores differ (10_000 = fixture price). */
  priceFactorBp?: number;
  latencyMs?: number;
  fixtures?: Fixture[];
  now?: () => Date;
}

export class MockConnector implements ShoppingConnector {
  readonly isMock = true;
  readonly id: string;
  readonly name: string;
  private readonly fixtures: Fixture[];

  constructor(private readonly options: MockConnectorOptions) {
    this.id = options.id;
    this.name = options.name;
    this.fixtures = options.fixtures ?? MOCK_FIXTURES;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      search: true,
      productLookup: true,
      categories: "all",
      price: true,
      mrp: true,
      stock: true,
      shipping: true,
      promotions: true,
      maxResultsPerRequest: 50,
      dealFeed: true,
    };
  }

  getReadiness(): ConnectorReadiness {
    return { state: "READY" };
  }

  private toItem(f: Fixture): NormalizedProductInput {
    const now = this.options.now?.() ?? new Date();
    const factor = this.options.priceFactorBp ?? 10_000;
    const price = Math.round((f.price * 100 * factor) / 10_000);
    return {
      sourceId: this.id,
      externalId: `${this.id}-${f.sku}`,
      title: f.title,
      brand: f.brand,
      productUrl: `https://${this.id.replace(/_/g, "-")}.example.com/p/${f.sku}`,
      sellingPricePaise: price,
      mrpPaise: f.mrp * 100,
      shippingPaise: price >= 500_000 ? 0 : 4_000, // free delivery from ₹5,000 (made up)
      priceType: "LISTED",
      currency: "INR",
      sellerName: `${this.name} Seller (mock)`,
      stockStatus: "IN_STOCK",
      variant: { attributes: f.variant },
      promotions: [
        {
          type: "BANK_OFFER",
          description: "Mock bank offer: 10% instant discount on Mock Bank cards",
          percentBasisPoints: 1_000,
          maxAmountPaise: 150_000,
        },
      ],
      observedAt: now,
      provenance: {
        method: "MOCK",
        provider: "dealmind-mock",
        operation: "fixtures",
        retrievedAt: now,
      },
    };
  }

  async search(
    request: ValidSearchRequest,
    ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput> {
    if (this.options.latencyMs) await sleep(this.options.latencyMs, ctx.signal);
    const tokens = request.query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t));
    const matches = this.fixtures.filter((f) => {
      const hay = `${f.title} ${f.brand} ${f.category}`.toLowerCase();
      if (request.category && f.category !== request.category) return false;
      if (
        request.brands?.length &&
        !request.brands.some((b) => b.toLowerCase() === f.brand.toLowerCase())
      )
        return false;
      return tokens.length > 0 && tokens.every((t) => hay.includes(t));
    });
    const items = matches
      .map((f) => this.toItem(f))
      .filter(
        (i) =>
          (request.minPricePaise === undefined || i.sellingPricePaise >= request.minPricePaise) &&
          (request.maxPricePaise === undefined || i.sellingPricePaise <= request.maxPricePaise),
      )
      .slice(0, request.limit);
    return { sourceId: this.id, items, totalAvailable: items.length, fetchedAt: new Date() };
  }

  /** The fixtures this store sells at least `minDiscountBp` below MRP (one page). */
  async fetchDeals(request: DealFeedRequest, ctx: ConnectorCallContext): Promise<DealFeedPage> {
    if (this.options.latencyMs) await sleep(this.options.latencyMs, ctx.signal);
    const items = this.fixtures
      .map((f) => this.toItem(f))
      .filter(
        (i) =>
          i.mrpPaise !== undefined &&
          i.mrpPaise > i.sellingPricePaise &&
          ((i.mrpPaise - i.sellingPricePaise) * 10_000) / i.mrpPaise >= request.minDiscountBp,
      );
    return { sourceId: this.id, items, fetchedAt: new Date() };
  }

  async getProduct(externalId: string): Promise<NormalizedProductInput | null> {
    const f = this.fixtures.find((x) => `${this.id}-${x.sku}` === externalId);
    return f ? this.toItem(f) : null;
  }

  async getHealth(): Promise<ConnectorHealth> {
    return { status: "HEALTHY", checkedAt: new Date(), message: "Mock connector (fictional data)" };
  }
}

/** Test double with scripted behaviour (retries, timeouts, circuit breaking). Never registered outside tests. */
export class ScriptedConnector implements ShoppingConnector {
  calls = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly script: (
      call: number,
      request: ValidSearchRequest,
      ctx: ConnectorCallContext,
    ) => Promise<ConnectorSearchResultInput>,
    private readonly readiness: ConnectorReadiness = { state: "READY" },
    private readonly capabilities: Partial<ConnectorCapabilities> = {},
    /** Test doubles behave like real connectors unless marked as mocks. */
    readonly isMock = false,
  ) {}

  getCapabilities(): ConnectorCapabilities {
    return {
      search: true,
      productLookup: false,
      categories: "all",
      price: true,
      mrp: true,
      stock: true,
      shipping: false,
      promotions: false,
      maxResultsPerRequest: 20,
      ...this.capabilities,
    };
  }

  getReadiness(): ConnectorReadiness {
    return this.readiness;
  }

  search(
    request: ValidSearchRequest,
    ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput> {
    this.calls += 1;
    return this.script(this.calls, request, ctx);
  }

  async getHealth(): Promise<ConnectorHealth> {
    if (this.readiness.state !== "READY")
      throw new ConnectorError("NOT_CONFIGURED", "not configured");
    return { status: "HEALTHY", checkedAt: new Date() };
  }
}
