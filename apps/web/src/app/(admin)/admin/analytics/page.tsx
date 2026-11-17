"use client";

import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useState } from "react";
import { AdminBarChart } from "@/components/admin/admin-bar-chart";
import {
  BarList,
  QueryState,
  StatGrid,
  StatTile,
  TableWrap,
  num,
  td,
  th,
} from "@/components/admin/admin-ui";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader, SegmentedControl } from "@/components/ui/misc";
import { percent } from "@/lib/format";
import { admin } from "@/services/admin";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export default function AdminAnalyticsPage() {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const q = useQuery({
    queryKey: ["admin", "analytics", days],
    queryFn: () => admin.analytics(Number(days)),
  });
  return (
    <>
      <PageHeader
        title="Search analytics"
        description="How searches perform. Query lists only include queries searched by several different people, and never show who searched."
        actions={
          <SegmentedControl label="Period" value={days} options={[...RANGES]} onChange={setDays} />
        }
      />
      <QueryState query={q} label="analytics">
        {(a) => (
          <>
            <StatGrid>
              <StatTile label="Searches" value={num(a.total)} hint={`Last ${a.days} days`} />
              <StatTile
                label="Success rate"
                value={percent(a.successRateBp)}
                hint={`Partial results: ${percent(a.partialRateBp)}`}
              />
              <StatTile
                label="Average time to finish"
                value={
                  a.averageDurationMs == null ? "—" : `${(a.averageDurationMs / 1000).toFixed(1)} s`
                }
              />
              <StatTile
                label="Agent runs"
                value={num(a.agentRuns.total)}
                hint={`${num(a.agentRuns.failed)} failed · ${num(a.agentRuns.cancelled)} cancelled`}
                tone={a.agentRuns.failed ? "warning" : undefined}
              />
            </StatGrid>
            <Card>
              <CardHeader title="Searches per day" description="Days in India time." />
              <AdminBarChart
                rows={a.daily.map((d) => ({
                  day: d.day,
                  ok: d.searches - d.failed,
                  failed: d.failed,
                }))}
                xKey="day"
                series={[
                  { key: "ok", label: "Finished" },
                  { key: "failed", label: "Failed" },
                ]}
                stacked
                label="Searches per day"
                formatX={dayLabel}
              />
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="Popular queries"
                  description={
                    <span className="inline-flex items-center gap-1">
                      <Lock aria-hidden className="size-3" /> Searched by at least {a.minUsers}{" "}
                      people
                    </span>
                  }
                />
                {a.popularQueries.length ? (
                  <BarList
                    label="Popular queries"
                    valueLabel="Searches"
                    rows={a.popularQueries.map((x) => ({
                      key: x.query,
                      label: x.query,
                      value: x.searches,
                      detail: `${num(x.users)} people`,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No query reaches the privacy threshold yet.
                  </p>
                )}
              </Card>
              <Card>
                <CardHeader
                  title="Queries with no results"
                  description={`Finished with no offers · at least ${a.minUsers} people`}
                />
                {a.emptyResultQueries.length ? (
                  <BarList
                    label="Queries with no results"
                    valueLabel="Searches"
                    rows={a.emptyResultQueries.map((x) => ({
                      key: x.query,
                      label: x.query,
                      value: x.searches,
                      detail: `${num(x.users)} people`,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">None above the privacy threshold.</p>
                )}
              </Card>
              <Card>
                <CardHeader
                  title="Categories"
                  description="From the understood intent or the chosen filter."
                />
                {a.categories.length ? (
                  <BarList
                    label="Searches by category"
                    valueLabel="Searches"
                    rows={a.categories.map((c) => ({
                      key: c.category,
                      label: c.category,
                      value: c.searches,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No searches in this period.</p>
                )}
              </Card>
              <Card>
                <CardHeader
                  title="Connector performance"
                  description="Per-source runs within searches."
                />
                {a.connectors.length ? (
                  <TableWrap label="Connector performance">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th scope="col" className={th}>
                            Source
                          </th>
                          <th scope="col" className={`${th} text-right`}>
                            Runs
                          </th>
                          <th scope="col" className={`${th} text-right`}>
                            Failed
                          </th>
                          <th scope="col" className={`${th} text-right`}>
                            Timed out
                          </th>
                          <th scope="col" className={`${th} text-right`}>
                            Avg
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.connectors.map((c) => (
                          <tr key={c.slug} className="border-t border-border">
                            <td className={td}>{c.slug}</td>
                            <td className={`${td} text-right tabular`}>{num(c.runs)}</td>
                            <td className={`${td} text-right tabular`}>{num(c.failed)}</td>
                            <td className={`${td} text-right tabular`}>{num(c.timedOut)}</td>
                            <td className={`${td} text-right tabular whitespace-nowrap`}>
                              {c.averageMs == null ? "—" : `${num(c.averageMs)} ms`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                ) : (
                  <p className="text-sm text-muted-foreground">No connector runs in this period.</p>
                )}
              </Card>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
