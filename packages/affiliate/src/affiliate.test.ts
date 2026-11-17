import { describe, expect, it, vi } from "vitest";
import {
  AffiliateRegistry,
  AmazonAssociatesProvider,
  FLIPKART_REPORT_URL,
  FlipkartAffiliateProvider,
  deviceClass,
  fetchFlipkartOrders,
  mapFlipkartStatus,
  referrerHost,
  rupeesToPaise,
  validateDestination,
} from "./index.js";

const amazon = {
  slug: "amazon_in",
  name: "Amazon India",
  domain: "amazon.in",
  affiliateEnabled: true,
};
const flipkart = {
  slug: "flipkart",
  name: "Flipkart",
  domain: "flipkart.com",
  affiliateEnabled: true,
};
const croma = { slug: "croma", name: "Croma", domain: "croma.com", affiliateEnabled: true };

describe("link generation", () => {
  it("adds only the program's own tracking parameters", () => {
    const a = new AmazonAssociatesProvider("dealmind-21").link(
      new URL("https://www.amazon.in/dp/B0TEST1234?th=1"),
    );
    expect(a).toEqual({
      url: "https://www.amazon.in/dp/B0TEST1234?th=1&tag=dealmind-21",
      trackingId: "dealmind-21",
    });
    // An existing tag is replaced, never duplicated.
    expect(
      new AmazonAssociatesProvider("dealmind-21").link(
        new URL("https://www.amazon.in/dp/X?tag=other-21"),
      ).url,
    ).toBe("https://www.amazon.in/dp/X?tag=dealmind-21");
    const f = new FlipkartAffiliateProvider("dealmindaff", false).link(
      new URL("https://www.flipkart.com/p/itm1"),
      { clickRef: "ref123" },
    );
    expect(f).toEqual({
      url: "https://www.flipkart.com/p/itm1?affid=dealmindaff&affExtParam1=ref123",
      trackingId: "dealmindaff",
    });
    expect(new AmazonAssociatesProvider(null).link(new URL("https://www.amazon.in/dp/X"))).toEqual({
      url: "https://www.amazon.in/dp/X",
      trackingId: null,
    });
  });

  it("uses a program only when enabled for the source and configured", () => {
    const r = new AffiliateRegistry({ amazonPartnerTag: "dealmind-21" });
    expect(r.forLinks(amazon).id).toBe("amazon-associates");
    expect(r.forLinks({ ...amazon, affiliateEnabled: false }).id).toBe("direct");
    expect(r.forLinks(flipkart).id).toBe("direct"); // no affiliate id configured
    expect(r.forLinks(croma).id).toBe("direct");
    expect(r.status(croma)).toMatchObject({ linksActive: false, reporting: "none" });
    expect(r.status(croma).note).toMatch(/networks/);
    expect(
      new AffiliateRegistry({ flipkartAffiliateId: "x", flipkartAffiliateToken: "t" }).status(
        flipkart,
      ),
    ).toMatchObject({
      linksActive: true,
      reporting: "api",
    });
  });
});

describe("destination validation (open redirect protection)", () => {
  const hosts = ["www.amazon.in", "amazon.in"];
  it("accepts the marketplace's own https hosts only", () => {
    expect(validateDestination("https://www.amazon.in/dp/X", hosts, "amazon.in").ok).toBe(true);
    for (const bad of [
      "http://www.amazon.in/dp/X",
      "https://evil.example/dp/X",
      "https://www.amazon.in.evil.example/dp/X",
      "https://user:pw@www.amazon.in/dp/X",
      "https://smile.amazon.in/dp/X", // subdomain not on the allowlist
      "javascript:alert(1)",
      "//evil.example",
      "not a url",
    ])
      expect(validateDestination(bad, hosts, "amazon.in").ok, bad).toBe(false);
    // Allowlisted host but a different source's domain.
    expect(validateDestination("https://www.amazon.in/x", hosts, "flipkart.com").ok).toBe(false);
  });

  it("keeps only coarse, non-identifying context", () => {
    expect(referrerHost("https://www.google.com/search?q=private+query")).toBe("www.google.com");
    expect(referrerHost("garbage")).toBeNull();
    expect(deviceClass("Mozilla/5.0 (Linux; Android 14) Mobile")).toBe("mobile");
    expect(deviceClass("Mozilla/5.0 (Windows NT 10.0)")).toBe("desktop");
  });
});

describe("Flipkart Orders Report", () => {
  const order = (
    id: string,
    status: string,
    sales: number | string,
    comm: number | string,
    sub?: string,
  ) => ({
    affiliateOrderItemId: id,
    status,
    sales: { amount: sales, currency: "INR" },
    tentativeCommission: { amount: comm, currency: "INR" },
    orderDate: "11-14-2026",
    affExtParam1: sub,
  });

  it("calls the documented endpoint with the affiliate headers, pages by offset, and converts exactly", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push(`${u.searchParams.get("status")}:${u.searchParams.get("offset")}`);
      expect(`${u.origin}${u.pathname}`).toBe(FLIPKART_REPORT_URL);
      expect(init?.headers).toMatchObject({
        "Fk-Affiliate-Id": "affid",
        "Fk-Affiliate-Token": "tok",
      });
      const status = u.searchParams.get("status");
      const offset = Number(u.searchParams.get("offset"));
      const list =
        status === "approved" && offset === 0
          ? [
              order("FK1", "approved", 24999, 249.99, "click-1"),
              order("FK2", "approved", "1000", "12.345"),
            ]
          : status === "cancelled" && offset === 0
            ? [order("FK3", "cancelled", 500, 5)]
            : [];
      return new Response(JSON.stringify({ orderList: list }), { status: 200 });
    });
    const r = await fetchFlipkartOrders({
      affiliateId: "affid",
      token: "tok",
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(calls).toEqual([
      "approved:0",
      "approved:2",
      "pending:0",
      "tentative:0",
      "cancelled:0",
      "cancelled:1",
    ]);
    expect(r.rows).toEqual([
      expect.objectContaining({
        orderRef: "FK1",
        orderAmountPaise: 2_499_900,
        commissionPaise: 24_999,
        status: "APPROVED",
        subId: "click-1",
        orderedAt: new Date("2026-11-14T00:00:00Z"),
      }),
      expect.objectContaining({ orderRef: "FK3", status: "REVERSED", commissionPaise: 500 }),
    ]);
    // 12.345 rupees isn't an exact paise amount: rejected, never rounded.
    expect(r.rejected.map((x) => x.orderRef)).toEqual(["FK2"]);
    expect(r.rejected[0]!.reason).toMatch(/Unparseable/);
  });

  it("fails loudly on a provider error instead of importing partial data", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(
      fetchFlipkartOrders({
        affiliateId: "a",
        token: "bad",
        startDate: "2026-11-01",
        endDate: "2026-11-02",
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("maps statuses and amounts", () => {
    expect(
      ["approved", "tentative", "pending", "cancelled", "disapproved", "failed"].map(
        mapFlipkartStatus,
      ),
    ).toEqual(["APPROVED", "PENDING", "PENDING", "REVERSED", "REVERSED", "REVERSED"]);
    expect(rupeesToPaise(24.8)).toBe(2_480);
    expect(() => rupeesToPaise(-1)).toThrow();
    expect(() => rupeesToPaise(undefined)).toThrow();
  });
});
