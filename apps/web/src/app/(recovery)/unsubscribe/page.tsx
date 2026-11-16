import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Unsubscribe } from "./unsubscribe";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

export default function UnsubscribePage() {
  return (
    <AuthShell title="Email notifications">
      <Suspense>
        <Unsubscribe />
      </Suspense>
    </AuthShell>
  );
}
