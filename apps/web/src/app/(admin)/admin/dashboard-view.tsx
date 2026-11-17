"use client";

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import Link from "next/link";
import {
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
import { PageHeader } from "@/components/ui/misc";
import { formatDateTime, rupees } from "@/lib/format";
import { admin } from "@/services/admin";

export function AdminDashboardView() {
  const q = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: admin.dashboard,
    refetchInterval: 60_000,
  });
  return (
    <>
      <PageHeader
        title="Platform dashboard"
        description="Live figures from DealMind's own records. Estimates are labelled as estimates."
      />
      <QueryState query={q} label="dashboard">
        {(d) => {
          const failingChecks = Object.values(d.infrastructure.checks).filter(
            (c) => c === "fail",
          ).length;
          const failedJobs = d.infrastructure.queues.reduce((n, x) => n + x.failed, 0);
          return (
            <>
              <section aria-labelledby="platform" className="flex flex-col gap-3">
                <h2 id="platform" className="text-lg font-semibold">
                  Platform
                </h2>
                <StatGrid>
                  <StatTile
                    label="Users"
                    value={num(d.platform.users)}
                    hint={`${num(d.platform.newUsers7d)} new in 7 days`}
                  />
                  <StatTile
                    label="Active users (30 days)"
                    value={num(d.platform.activeUsers30d)}
                    hint="Signed in during the last 30 days"
                  />
                  <StatTile
                    label="Searches"
                    value={num(d.platform.searches.total)}
                    hint={`${num(d.platform.searches.last30d)} in 30 days · ${num(d.platform.searches.failed)} failed`}
                  />
                  <StatTile
                    label="Active price alerts"
                    value={num(d.platform.activeAlerts)}
                    hint={`${num(d.platform.trackedOffers)} offers tracked`}
                  />
                </StatGrid>
              </section>

              <section aria-labelledby="revenue" className="flex flex-col gap-3">
                <h2 id="revenue" className="text-lg font-semibold">
                  Revenue
                </h2>
                <StatGrid>
                  <StatTile
                    label="Estimated MRR (subscriptions)"
                    value={rupees(d.revenue.subscriptions.estimatedMrrPaise)}
                    hint={`Estimate from list prices · ${num(d.revenue.subscriptions.activePaid)} paid subscribers`}
                  />
                  <StatTile
                    label="Refund events (30 days)"
                    value={num(d.revenue.subscriptions.refundEvents30d)}
                    hint="Reported by the payment service"
                  />
                  <StatTile
                    label="Confirmed affiliate commission"
                    value={rupees(d.revenue.affiliate.confirmedCommissionPaise)}
                    hint={`${num(d.revenue.affiliate.confirmedConversions)} partner-approved conversions`}
                  />
                  <StatTile
                    label="Pending affiliate commission"
                    value={rupees(d.revenue.affiliate.pendingCommissionPaise)}
                    hint={`Not yet approved · ${rupees(d.revenue.affiliate.paidOutPaise)} paid out`}
                  />
                </StatGrid>
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {d.revenue.subscriptions.collectedRevenueNote} Affiliate amounts are only what
                  partners reported; reversed or rejected:{" "}
                  {rupees(d.revenue.affiliate.reversedCommissionPaise)}.
                </p>
              </section>

              <section aria-labelledby="infra" className="flex flex-col gap-3">
                <h2 id="infra" className="text-lg font-semibold">
                  Infrastructure
                </h2>
                <StatGrid>
                  <StatTile
                    label="Failing checks"
                    value={num(failingChecks)}
                    tone={failingChecks ? "danger" : undefined}
                    hint={
                      <Link className="underline" href="/admin/system">
                        System health
                      </Link>
                    }
                  />
                  <StatTile
                    label="Failed jobs"
                    value={num(failedJobs)}
                    tone={failedJobs ? "warning" : undefined}
                    hint={
                      <Link className="underline" href="/admin/jobs">
                        Jobs
                      </Link>
                    }
                  />
                  <StatTile
                    label="Dead letters"
                    value={num(d.infrastructure.deadLetters)}
                    tone={d.infrastructure.deadLetters ? "warning" : undefined}
                  />
                  <StatTile label="Suspended users" value={num(d.platform.suspendedUsers)} />
                </StatGrid>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader title="Dependency checks" as="h3" />
                    <ul className="flex flex-col divide-y divide-border text-sm">
                      {Object.entries(d.infrastructure.checks)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([name, v]) => (
                          <li key={name} className="flex items-center justify-between gap-3 py-2">
                            <span>{labelOf(name)}</span>
                            <HealthBadge value={v} />
                          </li>
                        ))}
                    </ul>
                  </Card>
                  <Card>
                    <CardHeader
                      title="Connectors"
                      as="h3"
                      description="Status set by admins; health from the worker's checks."
                    />
                    <TableWrap label="Connectors">
                      <table className="w-full text-sm">
                        <thead>
                          <tr>
                            <th scope="col" className={th}>
                              Source
                            </th>
                            <th scope="col" className={th}>
                              Status
                            </th>
                            <th scope="col" className={th}>
                              Health
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.infrastructure.connectors.map((c) => (
                            <tr key={c.slug} className="border-t border-border">
                              <td className={td}>{c.name}</td>
                              <td className={td}>
                                <HealthBadge value={c.status} />
                              </td>
                              <td className={td}>
                                <HealthBadge value={c.health} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  </Card>
                </div>
                <p className="text-xs text-muted-foreground">
                  Updated {formatDateTime(d.generatedAt)}
                </p>
              </section>
            </>
          );
        }}
      </QueryState>
    </>
  );
}
