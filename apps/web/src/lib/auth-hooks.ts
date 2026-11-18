"use client";

import type { MeResponse, PublicUser } from "@dealmind/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ApiError, api } from "./api";
import { notifySignedOut } from "./pwa";
import { disablePush } from "./push";

export const ME_KEY = ["me"] as const;
const CHANNEL = "dealmind-auth";

/** Current user, kept in sync with the server session (refetched on focus). */
export function useMe(initialUser?: PublicUser | null) {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api<MeResponse>("GET", "/auth/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    ...(initialUser === undefined ? {} : { initialData: initialUser }),
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
}

/** Tells other open tabs that the session changed (login/logout). */
export function broadcastAuthChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage("changed");
  channel.close();
}

export function subscribeAuthChanges(onChange: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = onChange;
  return () => channel.close();
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async () => {
      // Signing out turns off push on this browser, so a shared phone stops showing this
      // user's alerts. Must run before the session ends (the server call needs it).
      await disablePush().catch(() => undefined);
      await api<void>("POST", "/auth/logout");
    },
    onSettled: () => {
      notifySignedOut();
      queryClient.setQueryData(ME_KEY, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      broadcastAuthChange();
      router.replace("/login");
      router.refresh();
    },
  });
}

/** Maps an API error to a user-facing message (never leaks internals). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return err.message || "Too many attempts. Please wait and try again.";
    if (err.status >= 500) return "Something went wrong on our side. Please try again.";
    return err.message;
  }
  return "Network error. Check your connection and try again.";
}
