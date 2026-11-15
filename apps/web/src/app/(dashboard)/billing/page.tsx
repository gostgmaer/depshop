import type { Metadata } from "next";
import { BillingView } from "./billing-view";

export const metadata: Metadata = { title: "Subscription" };

export default function BillingPage() {
  return <BillingView />;
}
