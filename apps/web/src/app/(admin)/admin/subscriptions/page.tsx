"use client";

import { useQuery } from "@tanstack/react-query";
import { CreditCard, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AdminBarChart } from "@/components/admin/admin-bar-chart";
import {
  BarList,
  HealthBadge,
  QueryState,
  StatGrid,
  StatTile,
  TableWrap,
  labelOf,
  num,
  td,
  th,
} from "@/components/admin/admin-ui";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, NativeSelect, PageHeader, Pagination } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDate, relativeTime, rupees } from "@/lib/format";
import { admin } from "@/services/admin";

const STATUSES = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED", "PAUSED"];
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });

function PaidList() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const q = useQuery({
    queryKey: ["admin", "paid-subscriptions", page, status],
    queryFn: () => admin.paidSubscriptions(page, status || undefined),
  });
  return (
    <Card>
      <CardHeader
        title="Paid subscriptions"
        action={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status</span>
            <NativeSelect
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelOf(s)}
                </option>
              ))}
            </NativeSelect>
          </label>
        }
      />
      {q.isPending ? (
        <LoadingRows label="Loading subscriptions" />
      ) : q.error ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No paid subscriptions"
          description="Paid plans appear here once checkout is live."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <TableWrap label="Paid subscriptions">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    User
                  </th>
                  <th scope="col" className={th}>
                    Plan
                  </th>
                  <th scope="col" className={th}>
                    Status
                  </th>
                  <th scope="col" className={th}>
                    Period end
                  </th>
                  <th scope="col" className={th}>
                    Synced
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((s) => (
                  <tr key={s.userId} className="border-t border-border">
                    <td className={td}>
                      <Link
                        href={`/admin/users/${s.userId}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {s.email}
                      </Link>
                    </td>
                    <td className={td}>
                      {s.plan}
                      {s.interval ? (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · {labelOf(s.interval)}
                        </span>
                      ) : null}
                      {s.effectivePlan !== s.plan ? (
                        <p className="text-xs text-muted-foreground">
                          In effect: {s.effectivePlan}
                        </p>
                      ) : null}
                    </td>
                    <td className={td}>
                      <HealthBadge value={s.status} />
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : "—"}
                      {s.cancelAtPeriodEnd ? (
                        <p className="text-xs text-muted-foreground">Cancels then</p>
                      ) : null}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{relativeTime(s.lastSyncedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <Pagination meta={q.data.pagination} onPage={setPage} />
        </div>
      )}
    </Card>
  );
}

export default function AdminSubscriptionsPage() {
  const q = useQuery({ queryKey: ["admin", "subscriptions"], queryFn: admin.subscriptions });
  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="DealMind's mirror of the payment service. Payments are never marked successful from here; the payment service is the source of truth."
      />
      <QueryState query={q} label="subscription analytics">
        {(s) => (
          <>
            <StatGrid>
              <StatTile label="Paid subscribers" value={num(s.activePaid)} />
              <StatTile
                label="Estimated MRR"
                value={rupees(s.estimatedMrrPaise)}
                hint="From list prices"
              />
              <StatTile
                label="Past due"
                value={num(s.pastDue)}
                tone={s.pastDue ? "warning" : undefined}
              />
              <StatTile
                label="Payment failures (30 days)"
                value={num(s.paymentFailures30d)}
                hint={`${num(s.cancelledOrEnded30d)} cancelled or ended`}
                tone={s.paymentFailures30d ? "warning" : undefined}
              />
            </StatGrid>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" /> {s.note}
            </p>
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <Card>
                <CardHeader
                  title="Subscription changes by month"
                  description="From synced subscription events."
                />
                <AdminBarChart
                  rows={s.monthly}
                  xKey="month"
                  series={[
                    { key: "activations", label: "Activations" },
                    { key: "cancellations", label: "Cancellations" },
                    { key: "paymentFailures", label: "Payment failures" },
                  ]}
                  label="Subscription changes by month"
                  formatX={monthLabel}
                />
              </Card>
              <Card>
                <CardHeader title="Users by plan in effect" />
                <BarList
                  label="Users by plan"
                  valueLabel="Users"
                  rows={s.plans.map((p) => ({
                    key: p.plan,
                    label: labelOf(p.plan),
                    value: p.users,
                  }))}
                />
                {Object.keys(s.webhookEvents).length ? (
                  <>
                    <h3 className="mt-5 mb-2 text-sm font-medium">
                      Payment-service events (30 days)
                    </h3>
                    <ul className="text-sm">
                      {Object.entries(s.webhookEvents).map(([k, v]) => (
                        <li key={k} className="flex justify-between border-t border-border py-1.5">
                          <code className="text-xs">{k}</code>
                          <span className="tabular">{num(v)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </Card>
            </div>
          </>
        )}
      </QueryState>
      <PaidList />
    </>
  );
}
