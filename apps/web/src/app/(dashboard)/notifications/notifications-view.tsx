"use client";

import type { NotificationCategoryValue } from "@dealmind/shared";
import { Bell, CheckCheck, Settings, ShieldAlert, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { errorMessage } from "@/lib/auth-hooks";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Notification } from "@/types/api";

export const CATEGORY_LABEL: Record<NotificationCategoryValue, string> = {
  PRICE_ALERTS: "Price alerts",
  SEARCH: "Searches",
  ACCOUNT: "Account",
  BILLING: "Billing",
};

export function NotificationList({
  items,
  onRead,
  onOpen,
  onDelete,
}: {
  items: Notification[];
  onRead: (id: string) => void;
  onOpen?: (n: Notification) => void;
  onDelete?: (id: string) => void;
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
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {n.critical ? (
                <Badge tone="warning">
                  <ShieldAlert aria-hidden className="size-3" /> Security
                </Badge>
              ) : null}
              {n.link && onOpen ? (
                <Link
                  href={n.link}
                  className="hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(n);
                  }}
                >
                  {n.title}
                </Link>
              ) : (
                n.title
              )}
              {!n.readAt ? <span className="sr-only"> (unread)</span> : null}
            </p>
            <p className="text-sm text-muted-foreground">{n.body}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {CATEGORY_LABEL[n.category]} · {relativeTime(n.createdAt)}
            </p>
          </div>
          <div className="flex items-start gap-1">
            {!n.readAt ? (
              <Button variant="ghost" size="sm" onClick={() => onRead(n.id)}>
                Mark read
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete notification: ${n.title}`}
                onClick={() => onDelete(n.id)}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

type CategoryTab = NotificationCategoryValue | "ALL";

export function NotificationsView() {
  const router = useRouter();
  const [unread, setUnread] = useState(false);
  const [category, setCategory] = useState<CategoryTab>("ALL");
  const [page, setPage] = useState(1);
  const q = useNotifications(unread || undefined, page, category === "ALL" ? undefined : category);
  const m = useNotificationMutations();
  const failed = [m.markRead, m.markAllRead, m.remove].find((x) => x.isError);
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/settings/notifications">
                <Settings aria-hidden className="size-4" /> Settings
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => m.markAllRead.mutate()}
              disabled={m.markAllRead.isPending}
            >
              <CheckCheck aria-hidden className="size-4" /> Mark all read
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap gap-3">
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
        <div className="relative overflow-x-auto">
          <SegmentedControl
            label="Notification category"
            value={category}
            onChange={(v) => {
              setCategory(v);
              setPage(1);
            }}
            options={[
              { value: "ALL", label: "Everything" },
              { value: "PRICE_ALERTS", label: CATEGORY_LABEL.PRICE_ALERTS },
              { value: "SEARCH", label: CATEGORY_LABEL.SEARCH },
              { value: "ACCOUNT", label: CATEGORY_LABEL.ACCOUNT },
              { value: "BILLING", label: CATEGORY_LABEL.BILLING },
            ]}
          />
        </div>
      </div>
      {failed ? <ErrorState message={errorMessage(failed.error)} /> : null}
      {q.isPending ? (
        <LoadingRows rows={4} label="Loading notifications" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load notifications." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <>
          <NotificationList
            items={q.data.items}
            onRead={(id) => m.markRead.mutate(id)}
            onOpen={(n) => {
              if (!n.readAt) m.markRead.mutate(n.id);
              if (n.link) router.push(n.link);
            }}
            onDelete={(id) => m.remove.mutate(id)}
          />
          <Pagination meta={q.data.pagination} onPage={setPage} />
        </>
      ) : (
        <EmptyState
          icon={Bell}
          title={unread ? "You're all caught up" : "No notifications yet"}
          description="Price alerts, finished searches and account notices appear here."
        />
      )}
    </>
  );
}
