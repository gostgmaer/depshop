"use client";

import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SegmentedControl,
} from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useNotificationMutations, useNotifications } from "@/hooks/queries";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Notification } from "@/types/api";

export function NotificationList({
  items,
  onRead,
}: {
  items: Notification[];
  onRead: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface shadow-(--shadow-card)">
      {items.map((n) => (
        <li key={n.id} className={cn("flex gap-3 px-4 py-3", !n.readAt && "bg-accent-soft/40")}>
          <span
            aria-hidden
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              n.readAt ? "bg-transparent" : "bg-accent",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {n.title}
              {!n.readAt ? <span className="sr-only"> (unread)</span> : null}
            </p>
            <p className="text-sm text-muted-foreground">{n.body}</p>
            <p className="mt-1 text-xs text-muted-foreground">{relativeTime(n.createdAt)}</p>
          </div>
          {!n.readAt ? (
            <Button variant="ghost" size="sm" onClick={() => onRead(n.id)}>
              Mark read
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function NotificationsView() {
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const q = useNotifications(unread || undefined, page);
  const m = useNotificationMutations();
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <Button
            variant="outline"
            onClick={() => m.markAllRead.mutate()}
            disabled={m.markAllRead.isPending}
          >
            <CheckCheck aria-hidden className="size-4" /> Mark all read
          </Button>
        }
      />
      <SegmentedControl
        label="Filter notifications"
        value={unread ? "unread" : "all"}
        onChange={(v) => {
          setUnread(v === "unread");
          setPage(1);
        }}
        options={[
          { value: "all", label: "All" },
          { value: "unread", label: "Unread" },
        ]}
      />
      {q.isPending ? (
        <LoadingRows rows={4} label="Loading notifications" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load notifications." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <>
          <NotificationList items={q.data.items} onRead={(id) => m.markRead.mutate(id)} />
          <Pagination meta={q.data.pagination} onPage={setPage} />
        </>
      ) : (
        <EmptyState
          icon={Bell}
          title={unread ? "You're all caught up" : "No notifications yet"}
          description="Price alerts and account updates appear here."
        />
      )}
    </>
  );
}
