"use client";

/**
 * Live notification updates over SSE (same-origin, session cookie). Each
 * event carries ids and the fresh unread count only; lists are re-fetched
 * through the authenticated API. EventSource reconnects on its own; the
 * unread-count query's polling covers any gap.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { notifications } from "@/services";

export function useNotificationStream(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource(notifications.streamUrl, { withCredentials: true });
    const setUnread = (raw: string) => {
      try {
        const { unread } = JSON.parse(raw) as { unread?: unknown };
        if (typeof unread === "number") qc.setQueryData(["notifications", "unread"], { unread });
      } catch {
        /* ignore malformed events */
      }
    };
    source.addEventListener("ready", (e) => setUnread((e as MessageEvent<string>).data));
    source.addEventListener("change", (e) => {
      setUnread((e as MessageEvent<string>).data);
      void qc.invalidateQueries({ queryKey: ["notifications", "list"] });
    });
    return () => source.close();
  }, [enabled, qc]);
}
