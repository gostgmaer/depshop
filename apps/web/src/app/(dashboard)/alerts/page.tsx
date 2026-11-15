import type { Metadata } from "next";
import { AlertsView } from "./alerts-view";

export const metadata: Metadata = { title: "Price alerts" };

export default function AlertsPage() {
  return <AlertsView />;
}
