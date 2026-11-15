import type { Metadata } from "next";
import { HistoryView } from "./history-view";

export const metadata: Metadata = { title: "Search history" };

export default function HistoryPage() {
  return <HistoryView />;
}
