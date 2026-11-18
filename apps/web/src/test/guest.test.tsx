/** Guests (no account): account-only controls become sign-in links and call no account API. */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PriceAlertDialog } from "@/components/alerts/price-alert-form";
import { WatchlistButton } from "@/components/products/watchlist-button";
import { ViewerProvider } from "@/lib/viewer";
import * as services from "@/services";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

vi.mock("@/services", () => ({
  watchlists: { list: vi.fn(async () => ({ items: [], pagination: {} })) },
  alerts: { list: vi.fn(async () => ({ items: [], pagination: {} })) },
}));
const svc = services as unknown as {
  watchlists: { list: ReturnType<typeof vi.fn> };
  alerts: { list: ReturnType<typeof vi.fn> };
};

describe("guest controls", () => {
  it("watchlist: a sign-in link back to this page, no watchlist request", () => {
    navigation.pathname = "/search/40000000-0000-7000-8000-000000000001";
    renderWithQuery(
      <ViewerProvider guest>
        <WatchlistButton variantId="20000000-0000-7000-8000-000000000001" />
      </ViewerProvider>,
    );
    const link = screen.getByRole("link", { name: /Sign in to save/ });
    expect(link).toHaveAttribute(
      "href",
      "/login?next=%2Fsearch%2F40000000-0000-7000-8000-000000000001",
    );
    expect(svc.watchlists.list).not.toHaveBeenCalled();
  });

  it("price alert: a sign-in link instead of the alert dialog", () => {
    navigation.pathname = "/products/10000000-0000-7000-8000-000000000001";
    renderWithQuery(
      <ViewerProvider guest>
        <PriceAlertDialog
          variantId="20000000-0000-7000-8000-000000000001"
          currentPricePaise={2_449_900}
          sources={[]}
        />
      </ViewerProvider>,
    );
    expect(screen.getByRole("link", { name: /Sign in for price alerts/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /alert/i })).toBeNull();
  });
});
