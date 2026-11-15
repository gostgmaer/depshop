"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/primitives";
import { ApiError, onSessionExpired } from "@/lib/api";
import { ME_KEY } from "@/lib/auth-hooks";

/** Retries transient failures (network, 5xx, 429) but never client errors. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) return error.status >= 500 || error.status === 429;
  return true;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  // Session expired or revoked mid-use: refresh the auth state; the app shell redirects.
  useEffect(() => onSessionExpired(() => client.setQueryData(ME_KEY, null)), [client]);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}
