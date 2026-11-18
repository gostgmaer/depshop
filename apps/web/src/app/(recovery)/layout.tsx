import type { Metadata } from "next";
import type { ReactNode } from "react";

/** Password reset, e-mail verification and unsubscribe pages carry one-time tokens: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function RecoveryLayout({ children }: { children: ReactNode }) {
  return children;
}
