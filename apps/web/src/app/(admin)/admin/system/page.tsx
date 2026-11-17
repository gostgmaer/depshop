"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import {
  HealthBadge,
  QueryState,
  TableWrap,
  labelOf,
  num,
  td,
  th,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { formatDateTime } from "@/lib/format";
import { admin } from "@/services/admin";

const CHECK_HELP: Record<string, string> = {
  db: "PostgreSQL",
  redis: "Redis (cache, rate limits, queues)",
  iam: "Shared EasyDev IAM",
  iamJwks: "IAM signing keys",
  notifications: "Shared notification service (email)",
  files: "Shared file-upload service",
  agent: "AI search agent",
  worker: "Background worker connected",
  payments: "Shared payment service",
};

export default function AdminSystemPage() {
  const q = useQuery({
    queryKey: ["admin", "system"],
    queryFn: admin.system,
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHeader
        title="System health"
        description="Dependency checks run by the API (3-second timeout each). 'Not configured' means the integration is off in this environment."
        actions={
          <Button variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>
            <RefreshCw aria-hidden className="size-4" /> {q.isFetching ? "Checking…" : "Check now"}
          </Button>
        }
      />
      <QueryState query={q} label="system health">
        {(s) => (
          <>
            <Card>
              <CardHeader title="Dependencies" description={`Checked ${formatDateTime(s.at)}`} />
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {Object.entries(s.checks)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, v]) => (
                    <li
                      key={name}
                      className="flex items-center justify-between gap-3 border-t border-border py-2.5 text-sm"
                    >
                      <span>
                        {labelOf(name)}
                        <span className="block text-xs text-muted-foreground">
                          {CHECK_HELP[name] ?? ""}
                        </span>
                      </span>
                      <HealthBadge value={v} />
                    </li>
                  ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Queues" />
              <TableWrap label="Queues">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th scope="col" className={th}>
                        Queue
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Workers
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Waiting
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Active
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Failed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.queues.map((x) => (
                      <tr key={x.name} className="border-t border-border">
                        <td className={td}>{x.name}</td>
                        <td className={`${td} text-right tabular`}>{num(x.workers)}</td>
                        <td className={`${td} text-right tabular`}>
                          {num((x.counts.waiting ?? 0) + (x.counts.prioritized ?? 0))}
                        </td>
                        <td className={`${td} text-right tabular`}>{num(x.counts.active ?? 0)}</td>
                        <td className={`${td} text-right tabular`}>{num(x.counts.failed ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          </>
        )}
      </QueryState>
    </>
  );
}
