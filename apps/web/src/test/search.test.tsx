/**
 * Phase 4.2: AI shopping search and real-time results. The API is mocked at
 * the typed service layer with contract-checked fixtures (contracts.test.ts),
 * so every test is deterministic.
 */
import { createSearchInput } from "@dealmind/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchView } from "@/app/(dashboard)/search/[id]/search-view";
import { compareRelations, parseCompareItems } from "@/components/compare/multi-compare";
import { AiSearchBar, buildSuggestions } from "@/components/search/ai-search-bar";
import { marketplaceRows } from "@/components/search/search-progress";
import {
  EMPTY_SEARCH,
  RANKING_CHOICES,
  fromSearch,
  rupeesText,
  toSearchInput,
} from "@/components/search/search-input";
import { timelineSteps } from "@/components/search/search-timeline";
import { initialProgress, progressReducer } from "@/hooks/use-search-events";
import { ApiError } from "@/lib/api";
import * as services from "@/services";
import type { SearchEvent, SourceStatus } from "@/types/api";
import { categoryFilters, searchDetail, searchResult, searchResultVariant } from "./fixtures";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

const SEARCH_ID = "40000000-0000-7000-8000-000000000001";
const SOURCES: SourceStatus["sources"] = [
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
    slug: "mock_beta",
    name: "Mock Store Beta",
    status: "ACTIVE",
    connectorStatus: "ACTIVE",
    statusReason: null,
    isSample: true,
    integrationKind: "MOCK",
    health: "HEALTHY",
    lastHealthCheckAt: null,
  },
  {
    slug: "amazon_in",
    name: "Amazon India",
    status: "PENDING_APPROVAL",
    connectorStatus: "PENDING_APPROVAL",
    statusReason: "Associates approval pending",
    isSample: false,
    integrationKind: "AFFILIATE_API",
    health: "UNKNOWN",
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
  {
    slug: "croma",
    name: "Croma",
    status: "DISABLED",
    connectorStatus: "DISABLED",
    statusReason: "No public API",
    isSample: false,
    integrationKind: "NONE",
    health: "UNKNOWN",
    lastHealthCheckAt: null,
  },
];

const page = <T,>(items: T[]) => ({
  items,
  pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 },
});

vi.mock("@/services", () => ({
  catalog: {
    categoryTree: vi.fn(async () => [
      {
        id: "30000000-0000-7000-8000-000000000001",
        slug: "smartphones",
        name: "Smartphones",
        description: null,
        imageUrl: null,
        parentId: null,
        children: [],
      },
      {
        id: "30000000-0000-7000-8000-000000000003",
        slug: "washing-machines",
        name: "Washing Machines",
        description: null,
        imageUrl: null,
        parentId: null,
        children: [],
      },
    ]),
    categoryFilters: vi.fn(),
    sourceStatus: vi.fn(),
    products: vi.fn(),
    product: vi.fn(),
    pricing: vi.fn(),
  },
  searches: {
    create: vi.fn(async () => ({ id: "40000000-0000-7000-8000-000000000009" })),
    list: vi.fn(),
    get: vi.fn(),
    results: vi.fn(),
    cancel: vi.fn(async () => ({})),
    eventsUrl: (id: string) => `/api/v1/search/${id}/events`,
  },
  watchlists: { list: vi.fn(async () => ({ items: [], pagination: {} })), addItem: vi.fn() },
  alerts: { create: vi.fn() },
  notifications: { unreadCount: vi.fn(async () => ({ unread: 0 })) },
  billing: { usage: vi.fn() },
}));

type Mocked = Record<string, Record<string, ReturnType<typeof vi.fn<(...args: never[]) => unknown>>>>;
const svc = services as unknown as Mocked;

beforeEach(() => {
  navigation.pathname = `/search/${SEARCH_ID}`;
  navigation.search = new URLSearchParams();
  svc.catalog!.sourceStatus!.mockResolvedValue({
    totalSources: SOURCES.length,
    activeSources: 2,
    healthySources: 2,
    sources: SOURCES,
  });
  svc.catalog!.categoryFilters!.mockImplementation(async (slug: string) => categoryFilters(slug));
  svc.catalog!.products!.mockResolvedValue(page([]));
  svc.searches!.list!.mockResolvedValue(
    page([
      {
        id: "s1",
        query: "Acme Nova under ₹30,000",
        filters: {},
        status: "COMPLETED",
        resultCount: 2,
        createdAt: "",
        completedAt: null,
      },
    ]),
  );
  svc.searches!.get!.mockResolvedValue(searchDetail());
  svc.searches!.results!.mockResolvedValue(page([]));
});

const ev = (e: SearchEvent) => ({ kind: "event" as const, event: e });
const queryBox = () => screen.getByRole("combobox", { name: "Describe what you want to buy" });

describe("1. natural-language search", () => {
  it("searches from words alone, with no form to complete", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.type(queryBox(), "Find the best washing machine under ₹25,000");
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await waitFor(() =>
      expect(svc.searches!.create).toHaveBeenCalledWith({
        query: "Find the best washing machine under ₹25,000",
      }),
    );
    expect(navigation.push).toHaveBeenCalledWith("/search/40000000-0000-7000-8000-000000000009");
  });

  it("autocompletes from history, the catalog (debounced) and examples, by keyboard", async () => {
    svc.catalog!.products!.mockResolvedValue(
      page([{ id: "p", name: "Acme Nova 7 5G" }] as never[]),
    );
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.type(queryBox(), "acme");
    const list = await screen.findByRole("listbox", { name: "Search suggestions" });
    expect(await within(list).findByText("Acme Nova 7 5G")).toBeInTheDocument();
    expect(within(list).getByText("Acme Nova under ₹30,000")).toBeInTheDocument();
    // One catalog request for the settled text, not one per keystroke.
    expect(svc.catalog!.products!).toHaveBeenCalledTimes(1);
    expect(svc.catalog!.products!.mock.calls[0]![0]).toEqual({ q: "acme", pageSize: 5 });
    await user.keyboard("{ArrowDown}");
    expect(queryBox()).toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");
    expect(queryBox()).toHaveValue("Acme Nova under ₹30,000");
    expect(svc.searches!.create).not.toHaveBeenCalled();
  });

  it("ranks suggestions recent → catalog → examples without duplicates", () => {
    const s = buildSuggestions("phone", ["cheap phone", "cheap phone"], ["Phone X"]);
    expect(s.slice(0, 2).map((x) => [x.kind, x.text])).toEqual([
      ["recent", "cheap phone"],
      ["product", "Phone X"],
    ]);
    // Matching examples follow; nothing appears twice.
    expect(s.slice(2).every((x) => x.kind === "example" && /phone/i.test(x.text))).toBe(true);
    expect(new Set(s.map((x) => x.text.toLowerCase())).size).toBe(s.length);
  });

  it("submits once even when clicked repeatedly", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    svc.searches!.create!.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar />);
    await user.type(queryBox(), "a laptop with 16GB RAM");
    const button = screen.getByRole("button", { name: /^Search/ });
    await user.click(button);
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(svc.searches!.create).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ id: "40000000-0000-7000-8000-000000000009" }));
  });
});

describe("2. search validation", () => {
  it("rejects a too-short query and an inverted budget before calling the API", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar initialFilters />);
    await user.type(queryBox(), "x");
    await user.type(screen.getByLabelText("Min price (₹)"), "50,000");
    await user.type(screen.getByLabelText("Max price (₹)"), "20,000");
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    expect(await screen.findByText("Describe what you are looking for")).toBeInTheDocument();
    expect(screen.getByText("Minimum is above the maximum")).toBeInTheDocument();
    expect(svc.searches!.create).not.toHaveBeenCalled();
  });

  it("never sends a user id: ownership comes from the session", () => {
    const input = toSearchInput({ ...EMPTY_SEARCH, query: "tv" });
    expect(JSON.stringify(input)).not.toContain("user");
    expect(createSearchInput.safeParse({ ...input, userId: "someone" }).success).toBe(false);
  });
});

describe("3. advanced filters", () => {
  it("sends discount, launch window, availability and marketplaces as explicit filters", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar initialFilters />);
    await user.type(queryBox(), "smartphone");
    await user.selectOptions(screen.getByLabelText("Minimum verified discount"), "20");
    await user.selectOptions(screen.getByLabelText("Launch date"), "90");
    await user.click(screen.getByRole("checkbox", { name: "Confirmed in stock only" }));
    await user.click(await screen.findByRole("checkbox", { name: /Mock Store Beta/ }));
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await waitFor(() =>
      expect(svc.searches!.create).toHaveBeenCalledWith({
        query: "smartphone",
        filters: {
          sourceSlugs: ["mock_beta"],
          minDiscountPercent: 20,
          launchedWithinDays: 90,
          inStockOnly: true,
        },
      }),
    );
  });

  it("offers only searchable marketplaces and names the others", async () => {
    renderWithQuery(<AiSearchBar initialFilters />);
    expect(await screen.findByRole("checkbox", { name: /Mock Store Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Flipkart/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Not searchable yet: Amazon India, Flipkart, Croma/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no rating filter/i)).toBeInTheDocument();
  });
});

describe("4. category-specific filters", () => {
  it("builds specification filters from the category's catalog data", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar initialFilters />);
    await user.type(queryBox(), "phone");
    await user.selectOptions(await screen.findByLabelText("Category"), "smartphones");
    const ram = await screen.findByLabelText("RAM");
    expect(within(ram).getByRole("option", { name: "8 GB (3)" })).toBeInTheDocument();
    await user.selectOptions(ram, "8 GB");
    await user.selectOptions(screen.getByLabelText("Subcategory"), "5g-phones");
    await user.click(screen.getByRole("checkbox", { name: /Acme/ }));
    expect(screen.getByText(/Current offers here: ₹20,000 – ₹30,000/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await waitFor(() =>
      expect(svc.searches!.create).toHaveBeenCalledWith({
        query: "phone",
        filters: { category: "5g-phones", brands: ["Acme"] },
      }),
    );
  });

  it("shows another category's own filters and drops the previous ones", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar initialFilters />);
    await user.type(queryBox(), "appliance");
    await user.selectOptions(await screen.findByLabelText("Category"), "smartphones");
    await user.selectOptions(await screen.findByLabelText("RAM"), "8 GB");
    await user.selectOptions(screen.getByLabelText("Category"), "washing-machines");
    const capacity = await screen.findByLabelText("Capacity");
    expect(screen.queryByLabelText("RAM")).not.toBeInTheDocument();
    await user.selectOptions(capacity, "7");
    // No launch dates are recorded here, so the launch filter can't be used.
    expect(screen.getByLabelText("Launch date")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await waitFor(() =>
      expect(svc.searches!.create).toHaveBeenCalledWith({
        query: "appliance",
        filters: { category: "washing-machines", specs: [{ name: "capacity_kg", value: "7" }] },
      }),
    );
  });
});

describe("5. ranking modes", () => {
  it("offers the five modes, explains the chosen one and states commission never counts", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AiSearchBar initialFilters />);
    const select = screen.getByLabelText("Ranking");
    const values = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["", ...RANKING_CHOICES]);
    expect(RANKING_CHOICES).toEqual([
      "best_value",
      "highest_discount",
      "lowest_price",
      "recently_launched",
      "price_drop",
    ]);
    await user.selectOptions(select, "highest_discount");
    expect(screen.getByText(/Biggest discount from a validated MRP first/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Affiliate commission never affects ranking/).length,
    ).toBeGreaterThan(0);
  });

  it("reports on the results page whether the user or the AI chose the mode", async () => {
    svc.searches!.get!.mockResolvedValue(
      searchDetail({ status: "COMPLETED", ranking: { mode: "lowest_price", chosenBy: "ai" } }),
    );
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByText("Lowest price")).toBeInTheDocument();
    expect(screen.getByText(/chosen by the AI from your words/)).toBeInTheDocument();
  });
});

describe("6. search progress updates", () => {
  it("marks a step done only when the agent reports it finished", () => {
    let p = progressReducer(
      initialProgress,
      ev({ type: "node_started", node: "intent_extractor", at: "" }),
    );
    let steps = timelineSteps(p, "RUNNING");
    expect(steps.find((s) => s.id === "accepted")?.state).toBe("done");
    expect(steps.find((s) => s.id === "understand")?.state).toBe("active");
    expect(steps.find((s) => s.id === "rank")?.state).toBe("pending");

    for (const node of ["intent_extractor", "query_validator"]) {
      p = progressReducer(p, ev({ type: "node_finished", node, at: "" }));
    }
    p = progressReducer(p, ev({ type: "node_started", node: "parallel_search", at: "" }));
    p = progressReducer(
      p,
      ev({ type: "sources_planned", sources: ["mock_alpha", "mock_beta"], skipped: [], at: "" }),
    );
    p = progressReducer(
      p,
      ev({
        type: "source_finished",
        source: "mock_alpha",
        status: "SUCCEEDED",
        resultCount: 3,
        at: "",
      }),
    );
    steps = timelineSteps(p, "RUNNING");
    expect(steps.find((s) => s.id === "understand")?.state).toBe("done");
    // Planning wasn't reported finished, so it isn't claimed.
    expect(steps.find((s) => s.id === "plan")?.state).toBe("pending");
    expect(steps.find((s) => s.id === "search")).toMatchObject({
      state: "active",
      detail: "1 of 2 marketplaces reported",
    });
    // No percentage anywhere.
    expect(JSON.stringify(steps)).not.toMatch(/%/);
  });

  it("shows unfinished steps as not reached when a search ends early", () => {
    const p = progressReducer(
      initialProgress,
      ev({ type: "node_finished", node: "query_validator", at: "" }),
    );
    const steps = timelineSteps(p, "CANCELLED");
    expect(steps.find((s) => s.id === "plan")?.state).toBe("not_reached");
    expect(steps.find((s) => s.id === "final")?.state).toBe("not_reached");
  });
});

describe("7. marketplace status updates", () => {
  it("lists every marketplace with its real state and why it wasn't searched", () => {
    const detail = searchDetail({
      status: "COMPLETED",
      filters: {},
      sourceRuns: [
        {
          source: { id: "a", slug: "mock_alpha", name: "Mock Store Alpha", isSample: true },
          status: "SUCCEEDED",
          resultCount: 3,
          durationMs: 10,
          errorCode: null,
          errorMessage: null,
        },
        {
          source: { id: "b", slug: "mock_beta", name: "Mock Store Beta", isSample: true },
          status: "TIMED_OUT",
          resultCount: 0,
          durationMs: 8000,
          errorCode: "TIMEOUT",
          errorMessage: null,
        },
        {
          source: { id: "c", slug: "amazon_in", name: "Amazon India", isSample: false },
          status: "SKIPPED",
          resultCount: 0,
          durationMs: 0,
          errorCode: "SOURCE_NOT_ACTIVE",
          errorMessage: "PENDING_APPROVAL",
        },
        {
          source: { id: "d", slug: "flipkart", name: "Flipkart", isSample: false },
          status: "SKIPPED",
          resultCount: 0,
          durationMs: 0,
          errorCode: "NOT_CONFIGURED",
          errorMessage: "missing: token",
        },
      ],
    });
    const rows = marketplaceRows(detail, initialProgress, SOURCES, false);
    const state = Object.fromEntries(rows.map((r) => [r.slug, r.state]));
    expect(state).toEqual({
      mock_alpha: "COMPLETED",
      mock_beta: "TIMED_OUT",
      amazon_in: "PENDING_APPROVAL",
      flipkart: "CREDENTIALS_UNAVAILABLE",
      croma: "DISABLED",
    });
  });

  it("follows live events while running and marks unselected marketplaces", () => {
    const live = progressReducer(
      initialProgress,
      ev({ type: "sources_planned", sources: ["mock_alpha"], skipped: [], at: "" }),
    );
    const rows = marketplaceRows(
      searchDetail({ filters: { sourceSlugs: ["mock_alpha"] } }),
      live,
      SOURCES,
      true,
    );
    const state = Object.fromEntries(rows.map((r) => [r.slug, r.state]));
    expect(state.mock_alpha).toBe("SEARCHING");
    expect(state.mock_beta).toBe("NOT_SELECTED");
  });
});

describe("8–9. partial results and failed sources", () => {
  it("labels partial results and names the failed marketplace", async () => {
    svc.searches!.get!.mockResolvedValue(
      searchDetail({
        status: "PARTIAL",
        resultCount: 1,
        completedAt: new Date().toISOString(),
        sourceRuns: [
          {
            source: { id: "a", slug: "mock_alpha", name: "Mock Store Alpha", isSample: true },
            status: "SUCCEEDED",
            resultCount: 3,
            durationMs: 10,
            errorCode: null,
            errorMessage: null,
          },
          {
            source: { id: "b", slug: "mock_beta", name: "Mock Store Beta", isSample: true },
            status: "FAILED",
            resultCount: 0,
            durationMs: 10,
            errorCode: "UPSTREAM",
            errorMessage: "Upstream error",
          },
        ],
      }),
    );
    svc.searches!.results!.mockResolvedValue(page([searchResult()]));
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByRole("heading", { name: "Partial results" })).toBeInTheDocument();
    expect(await screen.findByText(/cheaper offers there may be missing/)).toBeInTheDocument();
    expect(
      screen.getByText(/Mock Store Beta failed — results from the other marketplaces/),
    ).toBeInTheDocument();
    expect(screen.getByText("1 ranked deal")).toBeInTheDocument();
  });

  it("explains a failed search instead of an empty list", async () => {
    svc.searches!.get!.mockResolvedValue(
      searchDetail({
        status: "FAILED",
        sourceRuns: [
          {
            source: { id: "b", slug: "mock_beta", name: "Mock Store Beta", isSample: true },
            status: "FAILED",
            resultCount: 0,
            durationMs: 10,
            errorCode: "UPSTREAM",
            errorMessage: null,
          },
        ],
      }),
    );
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByText("The search failed")).toBeInTheDocument();
    expect(screen.getByText(/Every marketplace searched failed or timed out/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Run again/ }).length).toBeGreaterThan(0);
  });

  it("separates 'no listings' from 'nothing matched your filters'", async () => {
    svc.searches!.get!.mockResolvedValue(
      searchDetail({
        status: "COMPLETED",
        sourceRuns: [
          {
            source: { id: "a", slug: "mock_alpha", name: "Mock Store Alpha", isSample: true },
            status: "SUCCEEDED",
            resultCount: 5,
            durationMs: 10,
            errorCode: null,
            errorMessage: null,
          },
        ],
      }),
    );
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByText("No matching products")).toBeInTheDocument();
    expect(
      screen.getByText(/5 listings came back, but none met every requirement/),
    ).toBeInTheDocument();
  });

  it("flags expired results and offers fresh prices", async () => {
    const stale = searchResult();
    stale.offer = { ...stale.offer, isStale: true };
    svc.searches!.get!.mockResolvedValue(searchDetail({ status: "COMPLETED", resultCount: 1 }));
    svc.searches!.results!.mockResolvedValue(page([stale]));
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByText(/These results have expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get fresh prices" })).toBeInTheDocument();
  });
});

describe("10. search cancellation", () => {
  it("cancels a running search", async () => {
    svc.searches!.get!.mockResolvedValue(searchDetail({ status: "RUNNING" }));
    const user = userEvent.setup();
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    await user.click(await screen.findByRole("button", { name: /Cancel search/ }));
    await waitFor(() => expect(svc.searches!.cancel).toHaveBeenCalledWith(SEARCH_ID));
  });

  it("shows a cancelled search honestly", async () => {
    svc.searches!.get!.mockResolvedValue(searchDetail({ status: "CANCELLED" }));
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByText("Search cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel search/ })).not.toBeInTheDocument();
  });
});

describe("11. comparison selection", () => {
  it("collects picks into a compare link and flags different variants", async () => {
    svc.searches!.get!.mockResolvedValue(searchDetail({ status: "COMPLETED", resultCount: 2 }));
    svc.searches!.results!.mockResolvedValue(
      page([
        searchResult(1),
        searchResultVariant(2, 2, { ram_gb: 12, storage_gb: 256 }, 2_999_900),
      ]),
    );
    const user = userEvent.setup();
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    const boxes = await screen.findAllByRole("checkbox", { name: "Compare" });
    await user.click(boxes[0]!);
    expect(screen.getByText("Pick one more to compare")).toBeInTheDocument();
    await user.click(boxes[1]!);
    const tray = screen.getByRole("complementary", { name: "Products selected for comparison" });
    expect(within(tray).getByRole("link", { name: /Compare 2/ })).toHaveAttribute(
      "href",
      "/compare?items=10000000-0000-7000-8000-000000000001:20000000-0000-7000-8000-000000000001,10000000-0000-7000-8000-000000000001:20000000-0000-7000-8000-000000000002",
    );
  });

  it("never presents different variants or products as identical", () => {
    const P1 = "10000000-0000-7000-8000-000000000001";
    const P2 = "10000000-0000-7000-8000-000000000002";
    const V = (n: number) => `20000000-0000-7000-8000-00000000000${n}`;
    const items = parseCompareItems(
      `${P1}:${V(1)},${P1}:${V(2)},${P2}:${V(3)},bad:x,${P1}:${V(1)}`,
    );
    expect(items).toHaveLength(3);
    const r = compareRelations(items);
    expect(r.relation).toEqual(["different_variant", "different_variant", "different_product"]);
    expect(r.notes.join(" ")).toMatch(/different variants of the same product/);
    expect(r.notes.join(" ")).toMatch(/different products/);
  });
});

describe("12. search persistence", () => {
  it("restores a saved search's query and filters for editing", () => {
    const filters = toSearchInput({
      ...EMPTY_SEARCH,
      query: "phone",
      maxPrice: "35,000.50",
      category: "smartphones",
      brands: ["Acme"],
      sortMode: "lowest_price",
      minDiscount: "10",
      launchedWithin: "180",
      inStockOnly: true,
      specs: { ram_gb: "8 GB" },
    }).filters!;
    const restored = fromSearch("phone", filters);
    expect(toSearchInput(restored).filters).toEqual(filters);
    expect(rupeesText(3_500_050)).toBe("35000.50");
    // Unknown saved values are dropped, not guessed.
    expect(fromSearch("q", { sortMode: "affiliate", launchedWithinDays: 45 })).toMatchObject({
      sortMode: "",
      launchedWithin: "",
    });
  });

  it("edits and re-runs a previous search as a new search", async () => {
    svc.searches!.get!.mockResolvedValue(
      searchDetail({
        status: "COMPLETED",
        query: "Acme phone",
        filters: { maxPricePaise: 3_000_000, sortMode: "lowest_price" },
      }),
    );
    const user = userEvent.setup();
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    await user.click((await screen.findAllByRole("button", { name: /Run again/ }))[0]!);
    await waitFor(() =>
      expect(svc.searches!.create).toHaveBeenCalledWith({
        query: "Acme phone",
        filters: { maxPricePaise: 3_000_000, sortMode: "lowest_price" },
      }),
    );
    await user.click(screen.getAllByRole("button", { name: /Edit search/ })[0]!);
    const editor = screen.getByRole("region", { name: "Edit search" });
    expect(
      within(editor).getByRole("combobox", { name: "Describe what you want to buy" }),
    ).toHaveValue("Acme phone");
    expect(within(editor).getByLabelText("Max price (₹)")).toHaveValue("30000");
  });
});

describe("13. user search isolation", () => {
  it("shows another user's search as not found, without its data", async () => {
    svc.searches!.get!.mockRejectedValue(new ApiError(404, "NOT_FOUND", "Search not found"));
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    expect(await screen.findByText("Search not found")).toBeInTheDocument();
    expect(screen.getByText(/belongs to another account/)).toBeInTheDocument();
    expect(svc.searches!.results!).not.toHaveBeenCalled();
  });
});

describe("14. responsive results", () => {
  it("switches between list and grid through the URL", async () => {
    svc.searches!.get!.mockResolvedValue(searchDetail({ status: "COMPLETED", resultCount: 1 }));
    svc.searches!.results!.mockResolvedValue(page([searchResult()]));
    const user = userEvent.setup();
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    await user.click(await screen.findByRole("button", { name: "Grid" }));
    expect(navigation.replace).toHaveBeenCalledWith(`/search/${SEARCH_ID}?view=grid`, {
      scroll: false,
    });
    await user.selectOptions(screen.getByLabelText("Sort"), "price_asc");
    expect(navigation.replace).toHaveBeenCalledWith(`/search/${SEARCH_ID}?sort=price_asc`, {
      scroll: false,
    });
  });

  it("requests the sorted page from the API (re-ordering, not re-ranking)", async () => {
    navigation.search = new URLSearchParams("sort=discount_desc&page=2");
    svc.searches!.get!.mockResolvedValue(searchDetail({ status: "COMPLETED", resultCount: 1 }));
    renderWithQuery(<SearchView id={SEARCH_ID} />);
    await waitFor(() =>
      expect(svc.searches!.results!).toHaveBeenCalledWith(
        SEARCH_ID,
        { page: 2, sort: "discount_desc" },
        expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
      ),
    );
  });
});
