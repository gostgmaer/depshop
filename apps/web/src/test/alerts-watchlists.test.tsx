/** Phase 5.2 UI: alert management and watchlist prices (typed services mocked). */
import { alertView, watchlistDetail } from "@dealmind/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsView } from "@/app/(dashboard)/alerts/alerts-view";
import { WatchlistDetailView } from "@/app/(dashboard)/watchlists/[id]/watchlist-detail-view";
import { PriceAlertForm } from "@/components/alerts/price-alert-form";
import * as services from "@/services";
import type { PriceAlert, WatchlistDetail } from "@/types/api";
import { productDetail } from "./fixtures";
import { renderWithQuery } from "./render";

const V = productDetail().variants[0]!;
const product = { id: productDetail().id, name: "Acme Nova 7 5G", brand: "Acme", imageUrl: null };

function alertFixture(over: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: "a0000000-0000-7000-8000-000000000001",
    status: "ACTIVE",
    type: "TARGET_PRICE",
    targetPricePaise: 3_000_000,
    dropPercentBp: null,
    baselinePricePaise: 3_100_000,
    historicalWindowDays: null,
    cooldownMinutes: 1440,
    lastEvaluatedAt: null,
    minChangePaise: null,
    repeat: false,
    expiresAt: null,
    channels: ["IN_APP", "EMAIL"],
    triggerCount: 0,
    cancelledAt: null,
    current: {
      deliveredPaise: 3_050_000,
      marketplace: { slug: "mock_alpha", name: "Mock Store Alpha" },
      observedAt: new Date().toISOString(),
    },
    progressBp: 5_000,
    source: null,
    variant: V,
    product,
    lastTriggeredAt: null,
    lastTriggeredPricePaise: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const page = <T,>(items: T[]) => ({
  items,
  pagination: { page: 1, pageSize: 50, total: items.length, totalPages: 1 },
});

vi.mock("@/services", () => ({
  alerts: {
    list: vi.fn(),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    pause: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
    remove: vi.fn(async () => undefined),
    history: vi.fn(async () => page([])),
  },
  watchlists: { get: vi.fn(), rename: vi.fn(async () => ({})), removeItem: vi.fn() },
  billing: {
    usage: vi.fn(async () => ({
      plan: "FREE",
      items: [
        { key: "activeAlerts", label: "Active price alerts", used: 1, limit: 3, resetsAt: null },
      ],
      historyDays: 90,
      compareItems: 2,
    })),
  },
  notifications: { unreadCount: vi.fn(async () => ({ unread: 0 })) },
}));
type Mocked = Record<
  string,
  Record<string, ReturnType<typeof vi.fn<(...args: never[]) => unknown>>>
>;
const svc = services as unknown as Mocked;

beforeEach(() => {
  svc.alerts!.list!.mockImplementation(async (status?: string) =>
    page(
      [
        alertFixture(),
        alertFixture({
          id: "a0000000-0000-7000-8000-000000000002",
          status: "TRIGGERED",
          triggerCount: 1,
          lastTriggeredAt: new Date().toISOString(),
          progressBp: 10_000,
        }),
      ].filter((a) => !status || a.status === status),
    ),
  );
});

describe("fixtures", () => {
  it("match the API contracts", () => {
    expect(alertView.safeParse(alertFixture()).success).toBe(true);
    expect(watchlistDetail.safeParse(watchlistFixture()).success).toBe(true);
  });
});

describe("alerts page", () => {
  it("shows current price, marketplace and progress toward the target", async () => {
    renderWithQuery(<AlertsView />);
    const card = await screen.findByRole("article", { name: "Alert for Acme Nova 7 5G" });
    expect(within(card).getByText("₹30,500")).toBeInTheDocument();
    expect(within(card).getByText(/on Mock Store Alpha/)).toBeInTheDocument();
    const bar = within(card).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-valuetext", "50% of the way from ₹31,000 to ₹30,000");
    expect(svc.alerts!.list!.mock.calls[0]![0]).toBe("ACTIVE");
  });

  it("re-arms a triggered alert, cancels, and deletes only after confirming", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AlertsView />);
    await user.click(await screen.findByRole("button", { name: "Triggered" }));
    await user.click(await screen.findByRole("button", { name: "Turn alert back on" }));
    await waitFor(() =>
      expect(svc.alerts!.resume!).toHaveBeenCalledWith("a0000000-0000-7000-8000-000000000002"),
    );
    expect(screen.queryByRole("button", { name: "Pause alert" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel alert" }));
    await waitFor(() => expect(svc.alerts!.cancel!).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Delete alert" }));
    expect(svc.alerts!.remove!).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete alert" }));
    await waitFor(() =>
      expect(svc.alerts!.remove!).toHaveBeenCalledWith("a0000000-0000-7000-8000-000000000002"),
    );
  });

  it("edits an alert's target, channels and repeat", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AlertsView />);
    await user.click(await screen.findByRole("button", { name: "Edit alert for Acme Nova 7 5G" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit price alert" });
    const target = within(dialog).getByLabelText("Target price (₹)");
    expect(target).toHaveValue("30000");
    await user.clear(target);
    await user.type(target, "29,500");
    await user.click(within(dialog).getByRole("checkbox", { name: "Email" }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Keep watching/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(svc.alerts!.update!).toHaveBeenCalledWith("a0000000-0000-7000-8000-000000000001", {
        targetPricePaise: 2_950_000,
        cooldownMinutes: 1440,
        channels: ["IN_APP"],
        repeat: true,
        expiresAt: null,
      }),
    );
  });
});

describe("alert form conditions", () => {
  it("creates a preferred-marketplace drop with a minimum amount, email only", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <PriceAlertForm variantId={V.id} sources={[{ id: "s-beta", name: "Mock Store Beta" }]} />,
    );
    await user.selectOptions(screen.getByLabelText("Notify me when"), "PRICE_DROP");
    await user.selectOptions(screen.getByLabelText("Marketplace to watch"), "s-beta");
    await user.type(screen.getByLabelText(/changes by at least/), "500");
    await user.click(screen.getByRole("checkbox", { name: "In the app" }));
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    await waitFor(() =>
      expect(svc.alerts!.create!).toHaveBeenCalledWith({
        variantId: V.id,
        type: "PRICE_DROP",
        minChangePaise: 50_000,
        cooldownMinutes: 1440,
        channels: ["EMAIL"],
        sourceId: "s-beta",
      }),
    );
  });

  it("requires at least one channel", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PriceAlertForm variantId={V.id} sources={[]} />);
    await user.type(screen.getByLabelText("Target price (₹)"), "20000");
    await user.click(screen.getByRole("checkbox", { name: "In the app" }));
    await user.click(screen.getByRole("checkbox", { name: "Email" }));
    await user.click(screen.getByRole("button", { name: "Create alert" }));
    expect(await screen.findByText("Choose at least one way to be notified")).toBeInTheDocument();
    expect(svc.alerts!.create!).not.toHaveBeenCalled();
  });
});

function watchlistFixture(): WatchlistDetail {
  return {
    id: "50000000-0000-7000-8000-000000000001",
    name: "Smartphones to Buy",
    itemCount: 2,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    items: [
      {
        id: "51000000-0000-7000-8000-000000000001",
        note: null,
        addedAt: "2026-11-01T00:00:00.000Z",
        variant: V,
        product,
        lowestPricePaise: 3_100_000,
        current: {
          deliveredPaise: 3_100_000,
          marketplace: { slug: "mock_alpha", name: "Mock Store Alpha" },
          observedAt: new Date().toISOString(),
          offerCount: 2,
        },
        movement: { days: 7, previousPaise: 3_200_000, changePaise: -100_000, changeBp: -312 },
      },
      {
        id: "51000000-0000-7000-8000-000000000002",
        note: null,
        addedAt: "2026-11-01T00:00:00.000Z",
        variant: productDetail().variants[1]!,
        product,
        lowestPricePaise: null,
        current: null,
        movement: null,
      },
    ],
  };
}

describe("watchlist page", () => {
  it("shows the lowest offer, its marketplace and 7-day movement (or why there is none)", async () => {
    svc.watchlists!.get!.mockResolvedValue(watchlistFixture());
    const user = userEvent.setup();
    renderWithQuery(<WatchlistDetailView id="50000000-0000-7000-8000-000000000001" />);
    const cards = await screen.findAllByRole("article");
    expect(within(cards[0]!).getByText("₹31,000")).toBeInTheDocument();
    expect(
      within(cards[0]!).getByText(/on Mock Store Alpha · 2 current offers/),
    ).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/Down ₹1,000 \(3.12%\) in 7 days/)).toBeInTheDocument();
    expect(within(cards[1]!).getByText("No current, in-stock offer.")).toBeInTheDocument();
    expect(within(cards[1]!).getByText(/no price observed 7 days ago/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename watchlist" });
    const input = within(dialog).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Phones");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(svc.watchlists!.rename!).toHaveBeenCalledWith(
        "50000000-0000-7000-8000-000000000001",
        "Phones",
      ),
    );
  });
});
