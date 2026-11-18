"use client";

import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useState } from "react";
import { TableWrap, td, th } from "@/components/admin/admin-ui";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, NativeSelect, PageHeader, Pagination } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDateTime } from "@/lib/format";
import { admin } from "@/services/admin";

const FILTERS = [
  { value: "", label: "All actions" },
  { value: "admin.", label: "Admin actions" },
  { value: "admin.user_", label: "User administration" },
  { value: "admin.source_", label: "Connectors" },
  { value: "admin.ai_", label: "AI configuration" },
  { value: "admin.job_", label: "Job retries" },
  { value: "admin.product_", label: "Catalog corrections" },
  { value: "affiliate.", label: "Affiliate" },
  { value: "billing.", label: "Billing" },
  { value: "auth.", label: "Sign-in and account" },
];

/** Metadata summary without dumping raw JSON first (expandable for detail). */
function Meta({ metadata }: { metadata: Record<string, unknown> }) {
  const { reason, requestId: _r, ...rest } = metadata as { reason?: unknown; requestId?: unknown };
  const hasRest = Object.keys(rest).length > 0;
  return (
    <div className="flex flex-col gap-1 text-xs">
      {typeof reason === "string" ? <p>Reason: {reason}</p> : null}
      {hasRest ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <pre className="relative mt-1 max-w-md overflow-x-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap break-all">
            {JSON.stringify(rest, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export default function AdminAuditLogsPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const q = useQuery({
    queryKey: ["admin", "audit", page, action],
    queryFn: () => admin.audit(page, action || undefined),
  });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sensitive action, newest first: who, what, when, the request id and the stated reason. Secrets are never recorded."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Show</span>
            <NativeSelect
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        }
      />
      <Card>
        {q.isPending ? (
          <LoadingRows label="Loading audit log" />
        ) : q.error ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState icon={ScrollText} title="No entries" />
        ) : (
          <div className="flex flex-col gap-4">
            <TableWrap label="Audit log">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      When
                    </th>
                    <th scope="col" className={th}>
                      Who
                    </th>
                    <th scope="col" className={th}>
                      Action
                    </th>
                    <th scope="col" className={th}>
                      Target
                    </th>
                    <th scope="col" className={th}>
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className={`${td} whitespace-nowrap`}>
                        {formatDateTime(e.createdAt)}
                        {e.requestId ? (
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {e.requestId}
                          </p>
                        ) : null}
                      </td>
                      <td className={`${td} break-all`}>
                        {e.actorEmail ?? (e.actorId ? e.actorId : "System")}
                      </td>
                      <td className={td}>
                        <code className="text-xs">{e.action}</code>
                      </td>
                      <td className={td}>
                        {e.entity}
                        {e.entityId ? (
                          <p className="font-mono text-[11px] break-all text-muted-foreground">
                            {e.entityId}
                          </p>
                        ) : null}
                      </td>
                      <td className={td}>
                        <Meta metadata={e.metadata} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <Pagination meta={q.data.pagination} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}
