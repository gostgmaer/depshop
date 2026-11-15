/**
 * Phase 4.3: product comparison and price intelligence. The API is mocked at
 * the typed service layer with contract-checked fixtures (contracts.test.ts).
 */
import { describeStats, seriesStats } from "@dealmind/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductView } from "@/app/(dashboard)/products/[id]/product-view";
import {
  buildSeries,
  chartRows,
  chartSummary,
  priceAt,
} from "@/components/charts/price-history-chart";
import { MultiCompare, historyPosition } from "@/components/compare/multi-compare";
import { OfferComparisonTable } from "@/components/offers/offer-comparison-table";
import { PriceHistoryPanel, sourcePoints } from "@/components/products/price-history-panel";
import { TrackingPanel } from "@/components/products/tracking-panel";
import { ApiError } from "@/lib/api";
import { compareSpecs, groupOf } from "@/lib/spec-groups";
import * as services from "@/services";
import { priceHistory, productDetail, productPricing, recommendations } from "./fixtures";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

const PRODUCT = "10000000-0000-7000-8000-000000000001";
const V1 = "20000000-0000-7000-8000-000000000001";
const V2 = "20000000-0000-7000-8000-000000000002";
const OTHER = "10000000-0000-7000-8000-000000000002";
const page = <T,>(items: T[]) => ({
  items,
  pagination: { page: 1, pageSize: 50, total: items.length, totalPages: 1 },
});

vi.mock("@/services", () => ({
  catalog: {
    product: vi.fn(),
    pricing: vi.fn(),
    history: vi.fn(),
    compare: vi.fn(),
    products: vi.fn(),
    sourceStatus: vi.fn(async () => ({ sources: [] })),
  },
  watchlists: { list: vi.fn(), addItem: vi.fn(async () => ({})) },
  alerts: { list: vi.fn(), create: vi.fn(async () => ({})) },
  searches: { list: vi.fn() },
  notifications: { unreadCount: vi.fn(async () => ({ unread: 0 })) },
  billing: { usage: vi.fn() },
}));
type Mocked = Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const svc = services as unknown as Mocked;

beforeEach(() => {
  navigation.pathname = `/products/${PRODUCT}`;
  navigation.search = new URLSearchParams();
  svc.catalog!.product!.mockImplementation(async (id: string) =>
    id === PRODUCT
      ? productDetail()
      : productDetail({
          id,
          name: "Zenith Pro 2",
          brand: "Zenith",
          specifications: { Processor: "Zenith Z", Display: "6.1 inch OLED" },
          variants: [
            {
              id: "20000000-0000-7000-8000-000000000009",
              variantKey: "ram=8",
              attributes: { ram_gb: 8, storage_gb: 256 },
              sku: null,
              gtin: null,
            },
          ],
        }),
  );
  svc.catalog!.pricing!.mockImplementation(async () => productPricing());
  svc.catalog!.history!.mockImplementation(async () => priceHistory());
  svc.catalog!.compare!.mockImplementation(async () => ({
    items: [],
    recommendations: recommendations("00000000-0000-7000-8000-000000000002"),
  }));
  svc.catalog!.products!.mockResolvedValue(page([]));
  svc.watchlists!.list!.mockResolvedValue(page([]));
  svc.alerts!.list!.mockResolvedValue(page([]));
});

describe("1. product detail rendering", () => {
  it("shows overview, best offer, recommendations and category-grouped specifications", async () => {
    renderWithQuery(<ProductView id={PRODUCT} />);
    expect(
      await screen.findByRole("heading", { name: "Acme Nova 7 5G", level: 1 }),
    ).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Product overview" });
    expect(within(overview).getByText("Model AN7-5G")).toBeInTheDocument();
    expect(within(overview).getByRole("link", { name: "Smartphones" })).toBeInTheDocument();
    expect(within(overview).getByText("Sample data — not real offers")).toBeInTheDocument();
    expect(await screen.findByLabelText("Current best offer")).toHaveTextContent("₹24,539");
    expect(screen.getByRole("heading", { name: "Best deal recommendations" })).toBeInTheDocument();
    // Specifications are grouped for a phone: performance first, nothing invented.
    const perf = screen.getByRole("heading", { name: "Performance", level: 3 });
    expect(perf.nextElementSibling).toHaveTextContent("ProcessorAcme X1");
    expect(screen.getByRole("heading", { name: "Memory & storage", level: 3 })).toBeInTheDocument();
    expect(screen.queryByText(/Camera/)).not.toBeInTheDocument();
  });
});

describe("2. variant selection", () => {
  it("switches variants through the URL and prices the chosen variant", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ProductView id={PRODUCT} />);
    const v2 = await screen.findByRole("button", { name: "12 GB RAM · 256 GB · Midnight Black" });
    expect(
      screen.getByRole("button", { name: "8 GB RAM · 128 GB · Midnight Black" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(v2);
    expect(navigation.replace).toHaveBeenCalledWith(`/products/${PRODUCT}?variant=${V2}`, {
      scroll: false,
    });
  });

  it("uses the variant in the URL and ignores one that isn't this product's", async () => {
    navigation.search = new URLSearchParams(`variant=${V2}`);
    const { unmount } = renderWithQuery(<ProductView id={PRODUCT} />);
    await waitFor(() =>
      expect(svc.catalog!.pricing!).toHaveBeenCalledWith(PRODUCT, V2, { includeStale: false }),
    );
    unmount();
    vi.clearAllMocks();
    navigation.search = new URLSearchParams("variant=20000000-0000-7000-8000-00000000dead");
    renderWithQuery(<ProductView id={PRODUCT} />);
    await waitFor(() =>
      expect(svc.catalog!.pricing!).toHaveBeenCalledWith(PRODUCT, V1, { includeStale: false }),
    );
  });
});

describe("3–4. marketplace comparison and lowest price", () => {
  it("lists every offer field and marks only the lowest eligible delivered price", () => {
    renderWithQuery(<OfferComparisonTable data={productPricing()} />);
    const table = screen.getByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Marketplace",
      "Selling price",
      "MRP",
      "Direct discount",
      "Shipping",
      "Delivered price",
      "Availability",
      "Conditional offers",
      "Product link",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Mock Store 2")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Lowest delivered")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("₹40")).toBeInTheDocument(); // shipping
    expect(within(rows[0]!).getByText("₹24,539")).toBeInTheDocument(); // delivered
    expect(within(rows[0]!).getByText("Seller not stated")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("Lowest delivered")).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText("Free")).toBeInTheDocument();
    // Real listings link out, marked nofollow and opening in a new tab.
    const link = within(rows[0]!).getByRole("link", { name: /View on Mock Store 2/ });
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });
});

describe("5–7. price history: chart, missing data, per-marketplace", () => {
  const panel = (over: Partial<Parameters<typeof PriceHistoryPanel>[0]> = {}) => (
    <PriceHistoryPanel
      productId={PRODUCT}
      variantId={V1}
      period="30"
      source="all"
      showMrp={false}
      defaultSource="mock_2"
      sourceNames={{ mock_1: "Mock Store 1", mock_2: "Mock Store 2" }}
      onChange={() => undefined}
      {...over}
    />
  );

  it("renders the chart from observations, with stats and a table view", async () => {
    renderWithQuery(panel());
    const legend = await screen.findByRole("list", { name: "Legend" });
    expect(within(legend).getByText("Mock Store 1")).toBeInTheDocument();
    expect(within(legend).getByText("Mock Store 2")).toBeInTheDocument();
    expect(
      chartSummary(priceHistory(), buildSeries(priceHistory(), { mock_1: "Mock Store 1" })),
    ).toMatch(
      /Mock Store 1 ₹24,999 to ₹26,999 over 10 observations; mock_2 ₹24,499 to ₹24,599 over 8 observations.$/,
    );
    const stats = screen.getByRole("region", { name: "Price statistics" });
    expect(within(stats).getByText(/Mock Store 2/)).toBeInTheDocument();
    expect(within(stats).getByText(/mean of 8 observations/)).toBeInTheDocument();
    // 18 observations in the table view, newest first.
    const table = screen.getByRole("table", { name: "Observed prices" });
    expect(within(table).getAllByRole("row")).toHaveLength(19);
    expect(svc.catalog!.history!).toHaveBeenCalledWith(PRODUCT, { variantId: V1, days: 30 });
  });

  it("requests all stored history and never calls it all-time", async () => {
    renderWithQuery(panel({ period: "all", source: "mock_1" }));
    await screen.findByRole("region", { name: "Price statistics" });
    expect(svc.catalog!.history!).toHaveBeenCalledWith(PRODUCT, { variantId: V1, days: "all" });
    expect(screen.getByText(/Lowest observed price since tracking began on/)).toBeInTheDocument();
    expect(screen.getByText(/so these are not all-time figures/)).toBeInTheDocument();
    expect(screen.queryByText(/all-time low/i)).not.toBeInTheDocument();
  });

  it("shows gaps instead of inventing prices, and an honest empty state", async () => {
    const series = buildSeries(priceHistory(), {});
    const s1 = series.find((s) => s.slug === "mock_1")!;
    const t = (daysAgo: number) => s1.points.at(-1)!.t - daysAgo * 86_400_000;
    // Observed 17 days ago, next 11 days ago: the 6-day gap is not a held price.
    expect(priceAt(s1, t(14))).toBeNull();
    expect(priceAt(s1, t(17))?.price).toBe(2_649_900);
    // Between observations a day apart, the price is held.
    expect(priceAt(s1, t(9.5))?.price).toBe(2_599_900);
    const rows = chartRows(series, s1.points.at(-1)!.t);
    expect(rows.every((r) => r.t > 0)).toBe(true);
    expect(rows.filter((r) => r.s0_obs === 1)).toHaveLength(10);

    svc.catalog!.history!.mockResolvedValue({
      ...priceHistory(),
      points: [],
      lowestPricePaise: null,
      highestPricePaise: null,
    });
    renderWithQuery(panel({ period: "7" }));
    expect(await screen.findByText("No price observations in the last 7 days")).toBeInTheDocument();
    expect(screen.getByText(/has observed this variant since/)).toBeInTheDocument();
  });

  it("filters to one marketplace, offers its MRP, and states changes precisely", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(panel({ source: "mock_1", showMrp: true, onChange }));
    const stats = await screen.findByRole("region", { name: "Price statistics" });
    expect(within(stats).getByText("Mock Store 1")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show MRP" })).toBeChecked();
    expect(
      within(screen.getByRole("list", { name: "Legend" })).getByText("MRP (as stated)"),
    ).toBeInTheDocument();
    expect(within(stats).getByText(/gap.* of more than 48 hours/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Marketplace"), "mock_2");
    expect(onChange).toHaveBeenCalledWith({ source: "mock_2" });
    await user.click(screen.getByRole("button", { name: "1Y" }));
    expect(onChange).toHaveBeenCalledWith({ period: "365" });

    const s = seriesStats(sourcePoints(priceHistory(), "mock_1"));
    expect(describeStats(s, "last 30 days")).toEqual(
      expect.arrayContaining([
        "Lowest observed price in the last 30 days.",
        expect.stringMatching(/^Unchanged since the previous observation/),
      ]),
    );
  });
});

describe("8. comparison selection", () => {
  it("compares picked variants with recommendations, and adds a product from the page", async () => {
    const onChange = vi.fn();
    svc.catalog!.products!.mockResolvedValue(
      page([{ id: OTHER, name: "Zenith Pro 2", imageUrl: null, lowestPricePaise: 2_799_900 }]),
    );
    const user = userEvent.setup();
    const items = [
      { productId: PRODUCT, variantId: V1 },
      { productId: PRODUCT, variantId: V2 },
    ];
    renderWithQuery(<MultiCompare items={items} onChange={onChange} />);
    expect(
      await screen.findByRole("heading", { name: "Best deal across these products" }),
    ).toBeInTheDocument();
    expect(svc.catalog!.compare!).toHaveBeenCalledWith(items);
    expect(screen.getAllByText("Different variant").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/different variants of the same product/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Product name"), "zenith");
    await user.click(await screen.findByRole("button", { name: /Zenith Pro 2/ }));
    await user.selectOptions(
      await screen.findByLabelText(/Variant of Zenith Pro 2/),
      "20000000-0000-7000-8000-000000000009",
    );
    await user.click(screen.getByRole("button", { name: "Add to comparison" }));
    expect(onChange).toHaveBeenCalledWith([
      ...items,
      { productId: OTHER, variantId: "20000000-0000-7000-8000-000000000009" },
    ]);
  });
});

describe("9. category-specific specifications", () => {
  it("groups and orders specifications by category without equating unstated values", () => {
    const phone = compareSpecs(
      [
        { Processor: "Acme X1", ram_gb: 8, Battery: "5000 mAh", Display: "6.6 inch" },
        { Processor: "Zenith Z", ram_gb: 8, Display: "6.1 inch" },
      ],
      "smartphones",
    );
    expect(phone.map((g) => g.id)).toEqual(["performance", "memory", "battery", "display"]);
    const battery = phone.find((g) => g.id === "battery")!.rows[0]!;
    expect(battery).toMatchObject({ values: ["5000 mAh", null], differs: false, partial: true });
    expect(phone.find((g) => g.id === "memory")!.rows[0]).toMatchObject({
      label: "RAM",
      values: ["8 GB", "8 GB"],
      differs: false,
    });
    expect(phone.find((g) => g.id === "performance")!.rows[0]!.differs).toBe(true);

    const laptop = compareSpecs([{ GPU: "X", ssd_gb: 1024, Processor: "Y" }], "laptops");
    expect(laptop.map((g) => g.id)).toEqual(["performance", "memory", "graphics"]);
    expect(laptop.find((g) => g.id === "memory")!.rows[0]!.values).toEqual(["1 TB"]);
    const tv = compareSpecs(
      [{ "Panel Type": "OLED", "Refresh Rate": "120 Hz", Weight: "18 kg" }],
      "televisions",
    );
    expect(tv.map((g) => g.id)).toEqual(["display", "dimensions"]);
    const wash = compareSpecs(
      [{ capacity_kg: 7, "Energy Rating": "5 Star", Features: "Steam wash" }],
      "washing-machines",
    );
    expect(wash.map((g) => g.id)).toEqual(["capacity", "energy", "features"]);
    expect(groupOf("unusual_thing").id).toBe("other");
  });

  it("warns when compared products are in different categories", async () => {
    svc.catalog!.product!.mockImplementation(async (id: string) =>
      id === PRODUCT
        ? productDetail()
        : productDetail({
            id,
            name: "Acme Wash 7",
            category: {
              id: "70000000-0000-7000-8000-000000000002",
              slug: "washing-machines",
              name: "Washing Machines",
              description: null,
              imageUrl: null,
              parentId: null,
            },
            variants: [
              {
                id: "20000000-0000-7000-8000-000000000009",
                variantKey: "cap=7",
                attributes: { capacity_kg: 7 },
                sku: null,
                gtin: null,
              },
            ],
          }),
    );
    renderWithQuery(
      <MultiCompare
        items={[
          { productId: PRODUCT, variantId: V1 },
          { productId: OTHER, variantId: "20000000-0000-7000-8000-000000000009" },
        ]}
        onChange={() => undefined}
      />,
    );
    expect(
      await screen.findByText(/different categories \(Smartphones, Washing Machines\)/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Different product").length).toBeGreaterThanOrEqual(2);
  });
});

describe("10–11. watchlist and price alert integration", () => {
  it("shows your tracking history for the variant and creates an alert with a target and marketplace", async () => {
    svc.watchlists!.list!.mockResolvedValue(
      page([
        {
          id: "50000000-0000-7000-8000-000000000001",
          name: "Diwali phones",
          itemCount: 1,
          createdAt: "",
          updatedAt: "",
        },
      ]),
    );
    svc.alerts!.list!.mockResolvedValue(
      page([
        {
          id: "a1",
          status: "ACTIVE",
          targetPricePaise: 2_200_000,
          source: { id: "s2", slug: "mock_2", name: "Mock Store 2", isSample: true },
          variant: productDetail().variants[0],
          product: { id: PRODUCT, name: "Acme Nova 7 5G", brand: "Acme", imageUrl: null },
          lastTriggeredAt: null,
          lastTriggeredPricePaise: null,
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-01T00:00:00Z",
        },
      ]),
    );
    const user = userEvent.setup();
    renderWithQuery(
      <TrackingPanel
        variantId={V1}
        variantLabel="8 GB RAM · 128 GB"
        currentPricePaise={2_453_900}
        sources={[{ id: "s2", name: "Mock Store 2" }]}
      />,
    );
    expect(await screen.findByRole("link", { name: "Diwali phones" })).toBeInTheDocument();
    expect(screen.getByText("₹22,000")).toBeInTheDocument();
    expect(screen.getByText("on Mock Store 2", { exact: false })).toBeInTheDocument();
    expect(svc.alerts!.list!).toHaveBeenCalledWith(undefined, 1, V1);
    expect(svc.watchlists!.list!).toHaveBeenCalledWith({ variantId: V1 });

    await user.click(screen.getByRole("button", { name: /Price alert/ }));
    const dialog = await screen.findByRole("dialog", { name: "Create a price alert" });
    await user.type(within(dialog).getByLabelText("Target price (₹)"), "21,999.50");
    await user.selectOptions(within(dialog).getByLabelText("Marketplace"), "s2");
    await user.click(within(dialog).getByRole("button", { name: "Create alert" }));
    await waitFor(() =>
      expect(svc.alerts!.create!).toHaveBeenCalledWith({
        variantId: V1,
        targetPricePaise: 2_199_950,
        sourceId: "s2",
      }),
    );
  });
});

describe("12. responsive comparison", () => {
  it("renders mobile cards alongside the desktop table", () => {
    renderWithQuery(<OfferComparisonTable data={productPricing()} />);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("Selling")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Shipping")).toBeInTheDocument();
  });
});

describe("13. stale offer handling", () => {
  it("shows a stale offer as last seen, never lowest or current", () => {
    renderWithQuery(<OfferComparisonTable data={productPricing({ stale: true })} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    const stale = rows.find((r) => within(r).queryByText("Mock Store 3"))!;
    expect(within(stale).getByText("Not current")).toBeInTheDocument();
    expect(within(stale).getByText(/^last seen/)).toBeInTheDocument();
    expect(within(stale).queryByText("Lowest delivered")).not.toBeInTheDocument();
    // Cheaper but stale: the lowest mark stays on the current cheapest.
    const mock2 = rows.find((r) => within(r).queryByText("Mock Store 2"))!;
    expect(within(mock2).getByText("Lowest delivered")).toBeInTheDocument();
    expect(screen.getByText(/shown as last seen, not as current prices/)).toBeInTheDocument();
  });

  it("asks for stale offers only when the user opts in", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ProductView id={PRODUCT} />);
    await user.click(
      await screen.findByRole("checkbox", { name: "Include offers not seen recently" }),
    );
    expect(navigation.replace).toHaveBeenCalledWith(`/products/${PRODUCT}?stale=1`, {
      scroll: false,
    });
  });

  it("describes history position honestly", () => {
    expect(historyPosition(null)).toBe("No current offer");
    expect(historyPosition(productPricing().offers[0]!)).toBe(
      "Lowest observed price in the last 30 days",
    );
  });
});

describe("14. API error states", () => {
  it("recovers from a pricing error and reports a missing product", async () => {
    svc.catalog!.pricing!.mockRejectedValue(
      new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Pricing is temporarily unavailable"),
    );
    const user = userEvent.setup();
    const { unmount } = renderWithQuery(<ProductView id={PRODUCT} />);
    // 5xx details stay server-side; the user gets a recoverable message.
    expect(
      await screen.findByText("Something went wrong on our side. Please try again."),
    ).toBeInTheDocument();
    svc.catalog!.pricing!.mockResolvedValue(productPricing());
    await user.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByLabelText("Current best offer")).toBeInTheDocument();
    unmount();

    svc.catalog!.product!.mockRejectedValue(new ApiError(404, "NOT_FOUND", "Product not found"));
    renderWithQuery(<ProductView id={PRODUCT} />);
    expect(await screen.findByText("Product not found")).toBeInTheDocument();
  });

  it("keeps the page usable when history fails", async () => {
    svc.catalog!.history!.mockRejectedValue(new ApiError(500, "INTERNAL", "boom"));
    renderWithQuery(<ProductView id={PRODUCT} />);
    expect(await screen.findByText("Couldn't load price history.")).toBeInTheDocument();
    expect(screen.getByLabelText("Current best offer")).toBeInTheDocument();
  });
});
