"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { QueryState, ReasonDialog, TableWrap, num, td, th } from "@/components/admin/admin-ui";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDateTime } from "@/lib/format";
import { admin } from "@/services/admin";

const COUNT_COLUMNS = [
  "waiting",
  "prioritized",
  "active",
  "delayed",
  "failed",
  "completed",
] as const;

export default function AdminJobsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "jobs"], queryFn: admin.jobs, refetchInterval: 15_000 });
  const [retry, setRetry] = useState<{ queue: string; id: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ reason }: { reason: string }) => admin.retryJob(retry!.queue, retry!.id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
      setNotice(`Job ${retry!.id} was queued again.`);
      setRetry(null);
    },
  });
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Background queues. Failed jobs can be retried one at a time; job payloads (which may hold user data) aren't shown."
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <QueryState query={q} label="jobs">
        {(j) => (
          <>
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
                      {COUNT_COLUMNS.map((c) => (
                        <th key={c} scope="col" className={`${th} text-right capitalize`}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {j.queues.map((x) => (
                      <tr key={x.name} className="border-t border-border">
                        <td className={`${td} whitespace-nowrap`}>
                          {x.name}
                          {x.paused ? (
                            <span className="ml-1 text-xs text-warning">(paused)</span>
                          ) : null}
                        </td>
                        <td className={`${td} text-right tabular`}>{num(x.workers)}</td>
                        {COUNT_COLUMNS.map((c) => (
                          <td
                            key={c}
                            className={`${td} text-right tabular ${c === "failed" && x.counts[c] ? "text-danger" : ""}`}
                          >
                            {num(x.counts[c] ?? 0)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
            <Card>
              <CardHeader title="Recent failures" description="Up to 10 per queue, newest first." />
              {j.failed.length ? (
                <TableWrap label="Failed jobs">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className={th}>
                          Job
                        </th>
                        <th scope="col" className={th}>
                          Error
                        </th>
                        <th scope="col" className={`${th} text-right`}>
                          Attempts
                        </th>
                        <th scope="col" className={th}>
                          Failed
                        </th>
                        <th scope="col" className={th}>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {j.failed.map((f) => (
                        <tr key={`${f.queue}:${f.id}`} className="border-t border-border">
                          <td className={td}>
                            <span className="font-mono text-xs break-all">{f.id}</span>
                            <p className="text-xs text-muted-foreground">{f.queue}</p>
                          </td>
                          <td className={`${td} max-w-sm text-xs break-words`}>
                            {f.failedReason || "—"}
                          </td>
                          <td className={`${td} text-right tabular`}>{num(f.attemptsMade)}</td>
                          <td className={`${td} whitespace-nowrap`}>
                            {f.failedAt ? formatDateTime(f.failedAt) : "—"}
                          </td>
                          <td className={td}>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setRetry({ queue: f.queue, id: f.id })}
                            >
                              <RotateCcw aria-hidden className="size-4" /> Retry
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : (
                <p className="text-sm text-muted-foreground">No failed jobs.</p>
              )}
            </Card>
            <Card>
              <CardHeader
                title="Dead letters"
                description="Jobs that used every retry. Kept for inspection."
              />
              {j.deadLetters.length ? (
                <ul className="flex flex-col divide-y divide-border text-sm">
                  {j.deadLetters.map((d) => (
                    <li key={d.id} className="py-2">
                      <p>
                        <span className="font-mono text-xs break-all">{d.jobId}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          ({d.queue}, {num(d.attemptsMade)} attempts)
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground break-words">{d.failedReason}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No dead letters.</p>
              )}
            </Card>
          </>
        )}
      </QueryState>
      {retry ? (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setRetry(null);
              m.reset();
            }
          }}
          title="Retry this job?"
          description={`${retry.queue} · ${retry.id}. It runs again with its original data.`}
          confirmLabel="Retry job"
          pending={m.isPending}
          error={m.error ? errorMessage(m.error) : null}
          onConfirm={(reason) => m.mutate({ reason })}
        />
      ) : null}
    </>
  );
}
