/**
 * Deals-only mode (live store search off): the search box searches the stored deals,
 * the deals page filters by words, and the home page shows the top deals with links
 * to each product's page (price history and buy links).
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DealsView } from "@/app/(shop)/deals/deals-view";
import { HomeDeals } from "@/components/deals/home-deals";
import { AiSearchBar } from "@/components/search/ai-search-bar";
import * as services from "@/services";
import type { Deal } from "@/types/api";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

const DEAL: Deal = {
  productId: "10000000-0000-7000-8000-000000000001",
  variantId: "20000000-0000-7000-8000-000000000001",
  name: "Acme Nova 7 5G",
  brand: "Acme",
  imageUrl: null,
  category: { slug: "smartphones", name: "Smartphones" },
  attributes: { storage: "128 GB" },
  offer: {
    sourceSlug: "mock_store_a",
    sourceName: "Mock Store A",
    isSample: true,
    sellingPricePaise: 18_999_00,
    mrpPaise: 24_999_00,
    shippingPaise: 0,
    discountBp: 2_400,
    observedAt: new Date().toISOString(),
  },
  offerCount: 2,
};

const page = (items: Deal[]) => ({
  items,
  pagination: { page: 1, pageSize: 24, total: items.length, totalPages: items.length ? 1 : 0 },
});

vi.mock("@/services", () => ({
  catalog: {
    deals: vi.fn(),
    dealPolicy: vi.fn(async () => ({ minDiscountPercent: 20, liveSearch: false })),
    categoryTree: vi.fn(async () => []),
  },
  searches: { create: vi.fn(), list: vi.fn() },
}));
const svc = services as unknown as {
  catalog: Record<"deals" | "dealPolicy", ReturnType<typeof vi.fn>>;
  searches: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  navigation.pathname = "/deals";
  navigation.search = new URLSearchParams();
  svc.catalog.deals.mockResolvedValue(page([DEAL]));
});

describe("deals-only search", () => {
  it("the search box searches the current deals; no live search is started", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.type(await screen.findByRole("searchbox", { name: "Search deals" }), "nova phone");
    await user.click(screen.getByRole("button", { name: /Search deals/ }));
    expect(navigation.push).toHaveBeenCalledWith("/deals?q=nova%20phone");
    expect(svc.searches.create).not.toHaveBeenCalled();
  });

  it("the deals page sends the words to the API and says what matched", async () => {
    navigation.search = new URLSearchParams("q=nova");
    renderWithQuery(<DealsView />);
    expect(await screen.findByRole("heading", { name: /Deals matching “nova”/ })).toBeVisible();
    expect(svc.catalog.deals).toHaveBeenCalledWith(expect.objectContaining({ q: "nova" }));
    expect(await screen.findByText(/at least 20% below/)).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search deals" })).toHaveValue("nova");
  });

  it("no match: says so and offers to clear the search", async () => {
    navigation.search = new URLSearchParams("q=zzzz");
    svc.catalog.deals.mockResolvedValue(page([]));
    renderWithQuery(<DealsView />);
    expect(await screen.findByText("No current deals match “zzzz”")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear search" })).toHaveAttribute("href", "/deals");
  });
});

describe("home page deals", () => {
  it("lists the top deals, each opening its product page (price history and buy links)", async () => {
    renderWithQuery(<HomeDeals />);
    const link = await screen.findByRole("link", { name: "Price history & buy" });
    expect(link).toHaveAttribute("href", `/products/${DEAL.productId}`);
    expect(screen.getByRole("link", { name: DEAL.name })).toHaveAttribute(
      "href",
      `/products/${DEAL.productId}`,
    );
    expect(screen.getByText("24% off MRP")).toBeInTheDocument();
    // Mock-store data is always labelled.
    expect(screen.getByText(/Sample data/)).toBeInTheDocument();
    await waitFor(() =>
      expect(svc.catalog.deals).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 6 })),
    );
  });
});
