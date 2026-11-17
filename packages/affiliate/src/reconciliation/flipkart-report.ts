/**
 * Flipkart Affiliate Orders Report API client (documented at
 * affiliate.flipkart.com/api-docs/af_report_ref.html):
 *   GET https://affiliate-api.flipkart.net/affiliate/report/orders/detail/json
 *       ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&status=<status>&offset=<n>
 *   headers: Fk-Affiliate-Id, Fk-Affiliate-Token
 *   → { orderList: [{ affiliateOrderItemId, sales: {amount}, tentativeCommission: {amount},
 *        status, orderDate: "MM-DD-YYYY", affExtParam1, … }], next, … }
 *
 * Amounts are rupees; they are converted to paise exactly or the row is
 * rejected. Status mapping: approved → APPROVED; tentative/pending → PENDING;
 * cancelled/disapproved/failed → REVERSED.
 */
import { z } from "zod";
import { type ReportedConversion, rupeesToPaise } from "../commissions/import.js";

export const FLIPKART_REPORT_URL =
  "https://affiliate-api.flipkart.net/affiliate/report/orders/detail/json";
const QUERY_STATUSES = ["approved", "pending", "tentative", "cancelled"] as const;
const MAX_PAGES = 200;

const amount = z.object({ amount: z.union([z.number(), z.string()]) }).passthrough();
const order = z
  .object({
    affiliateOrderItemId: z.string().min(1),
    sales: amount,
    tentativeCommission: amount,
    status: z.string(),
    orderDate: z.string().optional(),
    affExtParam1: z.string().optional().nullable(),
  })
  .passthrough();
const page = z.object({ orderList: z.array(z.unknown()).default([]) }).passthrough();

export function mapFlipkartStatus(s: string): ReportedConversion["status"] {
  const v = s.toLowerCase();
  if (v === "approved") return "APPROVED";
  if (v === "tentative" || v === "pending") return "PENDING";
  if (v === "cancelled" || v === "disapproved" || v === "failed") return "REVERSED";
  return "PENDING";
}

const orderDate = (s: string | undefined): Date | null => {
  const m = s ? /^(\d{2})-(\d{2})-(\d{4})$/.exec(s) : null;
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : null;
};

export interface FlipkartReportResult {
  rows: ReportedConversion[];
  /** Rows that couldn't be imported exactly (never guessed). */
  rejected: { orderRef: string | null; reason: string }[];
}

export async function fetchFlipkartOrders(input: {
  affiliateId: string;
  token: string;
  startDate: string;
  endDate: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<FlipkartReportResult> {
  const f = input.fetch ?? fetch;
  const rows = new Map<string, ReportedConversion>();
  const rejected: FlipkartReportResult["rejected"] = [];
  for (const status of QUERY_STATUSES) {
    for (let p = 0, offset = 0; p < MAX_PAGES; p++) {
      const url = new URL(FLIPKART_REPORT_URL);
      url.searchParams.set("startDate", input.startDate);
      url.searchParams.set("endDate", input.endDate);
      url.searchParams.set("status", status);
      url.searchParams.set("offset", String(offset));
      const res = await f(url, {
        headers: {
          "Fk-Affiliate-Id": input.affiliateId,
          "Fk-Affiliate-Token": input.token,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
        // Credentials ride in custom headers: never follow a redirect with them.
        redirect: "error",
      });
      if (!res.ok) throw new Error(`Flipkart report ${status}: HTTP ${res.status}`);
      const body = page.parse(await res.json());
      if (!body.orderList.length) break;
      for (const item of body.orderList) {
        const parsed = order.safeParse(item);
        if (!parsed.success) {
          rejected.push({ orderRef: null, reason: "unrecognized order item" });
          continue;
        }
        const o = parsed.data;
        try {
          rows.set(o.affiliateOrderItemId, {
            orderRef: o.affiliateOrderItemId,
            orderAmountPaise: rupeesToPaise(o.sales.amount),
            commissionPaise: rupeesToPaise(o.tentativeCommission.amount),
            status: mapFlipkartStatus(o.status),
            providerStatus: o.status.slice(0, 100),
            orderedAt: orderDate(o.orderDate),
            subId: o.affExtParam1 ?? null,
          });
        } catch (err) {
          rejected.push({
            orderRef: o.affiliateOrderItemId,
            reason: (err as Error).message.slice(0, 200),
          });
        }
      }
      offset += body.orderList.length;
    }
  }
  return { rows: [...rows.values()], rejected };
}
