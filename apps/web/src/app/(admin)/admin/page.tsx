import type { Metadata } from "next";
import { AdminDashboardView } from "./dashboard-view";

export const metadata: Metadata = { title: "Dashboard" };

export default function AdminDashboardPage() {
  return <AdminDashboardView />;
}
