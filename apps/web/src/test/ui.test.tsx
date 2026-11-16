/**
 * Component tests (React Testing Library). The API is mocked at the typed
 * service layer with contract-checked fixtures (see contracts.test.ts).
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PriceAlertForm } from "@/components/alerts/price-alert-form";
import { SourceStatusCard, TrendingDeals } from "@/components/dashboard/widgets";
import { SidebarNav } from "@/components/navigation/sidebar-nav";
import { OfferComparisonTable } from "@/components/offers/offer-comparison-table";
import { WatchlistButton } from "@/components/products/watchlist-button";
import { AiSearchBar } from "@/components/search/ai-search-bar";
import { ResultCard } from "@/components/search/result-card";
import { SearchProgressPanel } from "@/components/search/search-progress";
import { toSearchInput, EMPTY_SEARCH } from "@/components/search/search-input";
import { ErrorState } from "@/components/ui/misc";
import { WatchlistsView } from "@/app/(dashboard)/watchlists/watchlists-view";
import { initialProgress, progressReducer } from "@/hooks/use-search-events";
import { describeAlert } from "@/lib/alerts";
import { ApiError } from "@/lib/api";
import { shouldRetry } from "@/app/providers";
import * as services from "@/services";
import { productPricing, searchDetail, searchResult } from "./fixtures";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

vi.mock("@/services", () => ({
  catalog: {
    categoryTree: vi.fn(async () => []),
    sourceStatus: vi.fn(async () => ({
      totalSources: 3,
      activeSources: 1,
      healthySources: 1,
      sources: [
        {
          slug: "mock_alpha",
          name: "Mock Store Alpha",
          status: "ACTIVE",
          connectorStatus: "ACTIVE",
          statusReason: null,
          isSample: true,
          integrationKind: "MOCK",
          health: "HEALTHY",
          lastHealthCheckAt: null,
        },
        {
          slug: "flipkart",
          name: "Flipkart",
          status: "PENDING_CREDENTIALS",
          connectorStatus: "PENDING_CREDENTIALS",
          statusReason: "Affiliate API token not configured",
          isSample: false,
          integrationKind: "AFFILIATE_FEED",
          health: "UNKNOWN",
          lastHealthCheckAt: null,
        },
      ],
    })),
    products: vi.fn(async () => ({
      items: [],
      pagination: { page: 1, pageSize: 5, total: 0, totalPages: 0 },
    })),
    categoryFilters: vi.fn(),
  },
  searches: {
    create: vi.fn(async () => ({ id: "40000000-0000-7000-8000-000000000009" })),
    list: vi.fn(async () => ({
      items: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    })),
    eventsUrl: (id: string) => `/api/v1/search/${id}/events`,
  },
  watchlists: {
    list: vi.fn(async () => ({
      items: [
        {
          id: "50000000-0000-7000-8000-000000000001",
          name: "Diwali phones",
          itemCount: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
      pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    })),
    create: vi.fn(),
    addItem: vi.fn(async () => ({})),
    remove: vi.fn(async () => undefined),
  },
  alerts: { create: vi.fn(async () => ({})) },
  notifications: { unreadCount: vi.fn(async () => ({ unread: 0 })) },
  billing: { usage: vi.fn() },
}));
const svc = services as unknown as {
  searches: { create: ReturnType<typeof vi.fn> };
  watchlists: { addItem: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  alerts: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  navigation.pathname = "/dashboard";
});

describe("1. dashboard rendering", () => {
  it("shows marketplace status honestly, with mock data labelled", async () => {
    renderWithQuery(<SourceStatusCard />);
    expect(await screen.findByText("Mock Store Alpha")).toBeInTheDocument();
    expect(screen.getByText("Mock data")).toBeInTheDocument();
    expect(screen.getByText("Affiliate API token not configured")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 marketplaces searchable")).toBeInTheDocument();
  });

  it("never invents trending deals", () => {
    renderWithQuery(<TrendingDeals />);
    expect(screen.getByText("Not available yet")).toBeInTheDocument();
  });
});

describe("2. navigation", () => {
  it("marks the current section and links every main area", () => {
    navigation.pathname = "/products/10000000-0000-7000-8000-000000000001";
    renderWithQuery(<SidebarNav />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const name of [
      "Dashboard",
      "AI Search",
      "Categories",
      "Compare",
      "Watchlists",
      "Price Alerts",
      "Search History",
      "Notifications",
      "Settings",
      "Subscription",
    ]) {
      expect(within(nav).getByRole("link", { name: new RegExp(name) })).toBeInTheDocument();
    }
    // Product pages belong to Categories.
    expect(within(nav).getByRole("link", { name: "Categories" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("4–5. search submission and filters", () => {
  it("submits the natural-language query and opens the live results page", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.type(
      screen.getByLabelText("Describe what you want to buy"),
      "cheapest 1.5-ton inverter AC",
    );
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await waitFor(() =>
      expect(svc.searches.create).toHaveBeenCalledWith({ query: "cheapest 1.5-ton inverter AC" }),
    );
    expect(navigation.push).toHaveBeenCalledWith("/search/40000000-0000-7000-8000-000000000009");
  });

  it("validates the query before calling the API", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    expect(await screen.findByText("Describe what you are looking for")).toBeInTheDocument();
    expect(svc.searches.create).not.toHaveBeenCalled();
  });

  it("sends explicit filters (budget in paise, ranking) that win over the AI", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.click(screen.getByRole("button", { name: "Show filters" }));
    await user.type(screen.getByLabelText("Describe what you want to buy"), "smartphone");
    await user.type(screen.getByLabelText("Max price (₹)"), "35,000");
    await user.selectOptions(screen.getByLabelText("Ranking"), "highest_discount");
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await waitFor(() =>
      expect(svc.searches.create).toHaveBeenCalledWith({
        query: "smartphone",
        filters: {
          maxPricePaise: 3_500_000,
          sortMode: "highest_discount",
        },
      }),
    );
  });

  it("maps form values to the strict API contract", () => {
    expect(
      toSearchInput({
        ...EMPTY_SEARCH,
        query: " tv ",
        brands: ["Sony", "LG", "sony"],
        minPrice: "40,000.50",
      }),
    ).toEqual({
      query: "tv",
      filters: { minPricePaise: 4_000_050, brands: ["Sony", "LG"] },
    });
  });
});

describe("6. search progress", () => {
  it("tracks marketplaces through the SSE events", () => {
    let s = progressReducer(initialProgress, {
      kind: "event",
      event: { type: "node_started", node: "parallel_search", at: "" },
    });
    s = progressReducer(s, {
      kind: "event",
      event: {
        type: "sources_planned",
        sources: ["mock_alpha", "mock_beta"],
        skipped: ["flipkart"],
        at: "",
      },
    });
    s = progressReducer(s, {
      kind: "event",
      event: {
        type: "source_finished",
        source: "mock_alpha",
        status: "SUCCEEDED",
        resultCount: 4,
        at: "",
      },
    });
    s = progressReducer(s, {
      kind: "event",
      event: {
        type: "source_finished",
        source: "mock_beta",
        status: "FAILED",
        resultCount: 0,
        at: "",
      },
    });
    expect(s.stage).toBe("parallel_search");
    expect(s.sources).toEqual({
      mock_alpha: { status: "SUCCEEDED", resultCount: 4 },
      mock_beta: { status: "FAILED", resultCount: 0 },
      flipkart: { status: "SKIPPED", resultCount: 0 },
    });
  });

  it("stays usable when a marketplace fails", () => {
    const live = {
      ...initialProgress,
      sources: {
        mock_alpha: { status: "SUCCEEDED" as const, resultCount: 4 },
        mock_beta: { status: "FAILED" as const, resultCount: 0 },
      },
    };
    renderWithQuery(<SearchProgressPanel detail={searchDetail()} live={live} running />);
    const list = screen.getByRole("list", { name: "Marketplace status" });
    expect(within(list).getByText(/Completed · 4 listings/)).toBeInTheDocument();
    expect(within(list).getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText(/results from the other marketplaces are still shown/),
    ).toBeInTheDocument();
  });
});

describe("7. product results", () => {
  it("shows verified facts and never presents a conditional offer as guaranteed", () => {
    renderWithQuery(<ResultCard result={searchResult()} />);
    expect(screen.getByText("Acme Nova 7 5G")).toBeInTheDocument();
    expect(screen.getByText("₹24,999")).toBeInTheDocument();
    expect(screen.getByText("16.66% off MRP")).toBeInTheDocument();
    expect(screen.getByText("Lowest observed price in the last 30 days")).toBeInTheDocument();
    const benefits = screen.getByRole("list", { name: "Offers and benefits" });
    expect(within(benefits).getByText("conditional · not guaranteed")).toBeInTheDocument();
    expect(within(benefits).getByText(/depends on your bank/)).toBeInTheDocument();
    expect(screen.getByText(/Price observed/)).toBeInTheDocument();
    expect(screen.getByText("8 GB RAM · 128 GB · Midnight Black")).toBeInTheDocument();
    expect(screen.getByText(/Model AN7-5G/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Marketplaces for Acme Nova 7 5G/ })).toHaveAttribute(
      "href",
      "/compare?product=10000000-0000-7000-8000-000000000001&variant=20000000-0000-7000-8000-000000000001",
    );
  });
});

describe("8. offer comparison", () => {
  it("orders by delivered price and marks the lowest", () => {
    renderWithQuery(<OfferComparisonTable data={productPricing()} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Mock Store 2")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Lowest delivered")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("₹24,539")).toBeInTheDocument();
  });
});

describe("9. watchlist actions", () => {
  it("adds the variant to the chosen watchlist", async () => {
    const user = userEvent.setup();
    renderWithQuery(<WatchlistButton variantId="20000000-0000-7000-8000-000000000001" />);
    await user.click(screen.getByRole("button", { name: /Watch/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Diwali phones/ }));
    await waitFor(() =>
      expect(svc.watchlists.addItem).toHaveBeenCalledWith(
        "50000000-0000-7000-8000-000000000001",
        "20000000-0000-7000-8000-000000000001",
        undefined,
      ),
    );
    expect(await screen.findByText("Added to watchlist")).toBeInTheDocument();
  });
});

describe("9b. watchlist deletion", () => {
  it("asks for confirmation in a dialog and only deletes on confirm", async () => {
    const user = userEvent.setup();
    renderWithQuery(<WatchlistsView />);
    await user.click(await screen.findByRole("button", { name: "Delete Diwali phones" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Delete “Diwali phones”/ });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(svc.watchlists.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete Diwali phones" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete watchlist",
      }),
    );
    await waitFor(() =>
      expect(svc.watchlists.remove).toHaveBeenCalledWith("50000000-0000-7000-8000-000000000001"),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});

describe("10. price alert creation", () => {
  it("parses rupees to integer paise and creates the alert", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <PriceAlertForm
        variantId="20000000-0000-7000-8000-000000000001"
        currentPricePaise={2_499_900}
        sources={[{ id: "30000000-0000-7000-8000-000000000001", name: "Mock Store 1" }]}
      />,
    );
    await user.type(screen.getByLabelText("Target price (₹)"), "22,999.50");
    await user.selectOptions(
      screen.getByLabelText("Marketplace"),
      "30000000-0000-7000-8000-000000000001",
    );
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    await waitFor(() =>
      expect(svc.alerts.create).toHaveBeenCalledWith({
        variantId: "20000000-0000-7000-8000-000000000001",
        type: "TARGET_PRICE",
        targetPricePaise: 2_299_950,
        cooldownMinutes: 1440,
        sourceId: "30000000-0000-7000-8000-000000000001",
      }),
    );
    // Says how and how often prices are actually checked.
    expect(await screen.findByText(/re-checks prices in the background/)).toBeInTheDocument();
  });

  it("creates other alert types with only their own parameters", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <PriceAlertForm variantId="20000000-0000-7000-8000-000000000001" sources={[]} />,
    );
    await user.selectOptions(screen.getByLabelText("Notify me when"), "PERCENT_DROP");
    expect(screen.queryByLabelText("Target price (₹)")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Drop by (%)"));
    await user.type(screen.getByLabelText("Drop by (%)"), "95");
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    expect(await screen.findByText("Enter a whole percent from 1 to 90")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Drop by (%)"));
    await user.type(screen.getByLabelText("Drop by (%)"), "15");
    await user.selectOptions(screen.getByLabelText("Notify at most once every"), "360");
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    await waitFor(() =>
      expect(svc.alerts.create).toHaveBeenCalledWith({
        variantId: "20000000-0000-7000-8000-000000000001",
        type: "PERCENT_DROP",
        dropPercent: 15,
        cooldownMinutes: 360,
      }),
    );
  });

  it("describes every alert type plainly", () => {
    const base = {
      targetPricePaise: null,
      dropPercentBp: null,
      baselinePricePaise: null,
      historicalWindowDays: null,
    };
    expect(describeAlert({ ...base, type: "TARGET_PRICE", targetPricePaise: 2_299_900 })).toBe(
      "At or below ₹22,999",
    );
    expect(describeAlert({ ...base, type: "PERCENT_DROP", dropPercentBp: 1000 })).toBe(
      "Drops 10% (baseline set at the next price check)",
    );
    expect(
      describeAlert({
        ...base,
        type: "PERCENT_DROP",
        dropPercentBp: 1000,
        baselinePricePaise: 2_500_000,
      }),
    ).toBe("Drops 10% from ₹25,000");
    expect(describeAlert({ ...base, type: "HISTORICAL_LOW", historicalWindowDays: 90 })).toBe(
      "Lowest observed in 90 days",
    );
    expect(describeAlert({ ...base, type: "BACK_IN_STOCK" })).toBe("Back in stock");
  });

  it("rejects an unparseable amount", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PriceAlertForm variantId="x" sources={[]} />);
    await user.type(screen.getByLabelText("Target price (₹)"), "twenty");
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    expect(await screen.findByText(/Enter an amount like/)).toBeInTheDocument();
    expect(svc.alerts.create).not.toHaveBeenCalled();
  });
});

describe("11. API error states", () => {
  it("offers a retry and only retries transient failures", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<ErrorState message="Couldn't load deals." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load deals.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    expect(shouldRetry(0, new ApiError(503, "DEPENDENCY_UNAVAILABLE", "x"))).toBe(true);
    expect(shouldRetry(0, new ApiError(404, "NOT_FOUND", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(422, "VALIDATION_ERROR", "x"))).toBe(false);
    expect(shouldRetry(2, new TypeError("network"))).toBe(false);
  });
});
