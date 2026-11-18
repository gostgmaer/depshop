"use client";

import type { AdminSourceView } from "@dealmind/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Power, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { HealthBadge, QueryState, ReasonDialog, num } from "@/components/admin/admin-ui";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/misc";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/auth-hooks";
import { relativeTime } from "@/lib/format";
import { admin } from "@/services/admin";

type Pending =
  | { kind: "status"; source: AdminSourceView; to: "ACTIVE" | "DISABLED" }
  | { kind: "health" }
  | null;

const SETTINGS = [
  { key: "timeoutMs", label: "Timeout (ms)", min: 1000, max: 60000 },
  { key: "rateLimitPerMinute", label: "Rate limit (requests/min)", min: 1, max: 10000 },
  { key: "maxRetries", label: "Max retries", min: 0, max: 5 },
  { key: "cacheTtlSeconds", label: "Cache TTL (seconds)", min: 0, max: 86400 },
] as const;

function SettingsDialog({ source, onClose }: { source: AdminSourceView; onClose: () => void }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(SETTINGS.map((s) => [s.key, String(source.settings[s.key])])),
  );
  const [tracking, setTracking] = useState(source.settings.trackingEnabled);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => admin.updateSource(source.id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "sources"] });
      onClose();
    },
  });
  const changes: Record<string, unknown> = {};
  for (const s of SETTINGS) {
    const v = Number(values[s.key]);
    if (values[s.key] !== "" && Number.isInteger(v) && v !== source.settings[s.key])
      changes[s.key] = v;
  }
  if (tracking !== source.settings.trackingEnabled) changes.trackingEnabled = tracking;
  const invalid = SETTINGS.some((s) => {
    const v = Number(values[s.key]);
    return !Number.isInteger(v) || v < s.min || v > s.max;
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${source.name} settings`}
        description="Non-secret settings only. Credentials are set in the server environment."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({ ...changes, reason: reason.trim() });
          }}
        >
          {SETTINGS.map((s) => (
            <Field key={s.key} label={s.label} hint={`${num(s.min)}–${num(s.max)}`}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={s.min}
                  max={s.max}
                  value={values[s.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={tracking}
              onChange={(e) => setTracking(e.target.checked)}
              className="size-4"
            />
            Price tracking enabled
          </label>
          <Field label="Reason (recorded in the audit log)">
            {(p) => (
              <Input
                {...p}
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          {m.error ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(m.error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={
                invalid || !Object.keys(changes).length || reason.trim().length < 3 || m.isPending
              }
            >
              {m.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminSourcesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "sources"], queryFn: admin.sources });
  const [pending, setPending] = useState<Pending>(null);
  const [editing, setEditing] = useState<AdminSourceView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async ({ p, reason }: { p: NonNullable<Pending>; reason: string }) => {
      if (p.kind === "health") return admin.healthCheck(reason);
      return admin.updateSource(p.source.id, { status: p.to, reason });
    },
    onSuccess: (_r, { p }) => {
      void qc.invalidateQueries({ queryKey: ["admin", "sources"] });
      setPending(null);
      setNotice(
        p.kind === "health"
          ? "Health check queued; results appear here when the worker finishes."
          : "Source updated.",
      );
    },
  });
  return (
    <>
      <PageHeader
        title="Connectors"
        description="Marketplace sources. A source can only be enabled when its connector is registered and its credentials are configured; credential values are never shown."
        actions={
          <Button variant="outline" onClick={() => setPending({ kind: "health" })}>
            <RefreshCw aria-hidden className="size-4" /> Run health check
          </Button>
        }
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <QueryState query={q} label="connectors">
        {(sources) => (
          <div className="grid gap-4 xl:grid-cols-2">
            {sources.map((s) => (
              <Card key={s.id} className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold">
                      {s.name} {s.isSample ? <Badge tone="warning">Sample data</Badge> : null}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {s.domain} · {s.integrationKind.toLowerCase().replace(/_/g, " ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <HealthBadge value={s.status} />
                    <HealthBadge value={s.health} />
                  </div>
                </div>
                {s.statusReason ? (
                  <p className="text-sm text-muted-foreground">{s.statusReason}</p>
                ) : null}
                <div className="flex items-start gap-2 text-sm">
                  <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {s.credentials.state === "NOT_REGISTERED" ? (
                    <span>No connector registered for this source.</span>
                  ) : s.credentials.state === "READY" ? (
                    <span>Connector ready (credentials configured).</span>
                  ) : s.credentials.state === "PENDING_CREDENTIALS" ? (
                    <span>
                      Missing credentials:{" "}
                      {s.credentials.missing.map((name) => (
                        <code key={name} className="mr-1 rounded bg-muted px-1 text-xs">
                          {name}
                        </code>
                      ))}
                    </span>
                  ) : (
                    <span>
                      {s.credentials.state === "PENDING_APPROVAL"
                        ? "Awaiting partner approval: no authorized integration yet."
                        : "Not supported."}
                      {s.credentials.reason ? ` ${s.credentials.reason}` : ""}
                    </span>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Requests</dt>
                    <dd className="tabular">{num(s.metrics.requests)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Failures / timeouts</dt>
                    <dd className="tabular">
                      {num(s.metrics.failures)} / {num(s.metrics.timeouts)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Avg latency</dt>
                    <dd className="tabular">
                      {s.metrics.averageLatencyMs == null
                        ? "—"
                        : `${num(s.metrics.averageLatencyMs)} ms`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Search runs (30 d)</dt>
                    <dd className="tabular">
                      {num(s.searchRuns30d.total)} ({num(s.searchRuns30d.failed)} failed)
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last success</dt>
                    <dd>{relativeTime(s.lastSuccessAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last health check</dt>
                    <dd>{relativeTime(s.lastHealthCheckAt)}</dd>
                  </div>
                </dl>
                {s.lastHealthError ? (
                  <p className="text-xs text-danger">Last error: {s.lastHealthError}</p>
                ) : null}
                <div className="mt-auto flex flex-wrap gap-2">
                  {s.status === "ACTIVE" ? (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setPending({ kind: "status", source: s, to: "DISABLED" })}
                    >
                      <Power aria-hidden className="size-4" /> Disable
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => setPending({ kind: "status", source: s, to: "ACTIVE" })}
                      disabled={
                        !s.isSample && (!s.connectorRegistered || !s.credentials.configured)
                      }
                    >
                      <Power aria-hidden className="size-4" /> Enable
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                    <SlidersHorizontal aria-hidden className="size-4" /> Settings
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      {pending ? (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setPending(null);
              m.reset();
            }
          }}
          title={
            pending.kind === "health"
              ? "Run a connector health check?"
              : `${pending.to === "ACTIVE" ? "Enable" : "Disable"} ${pending.source.name}?`
          }
          description={
            pending.kind === "health"
              ? "Queues one health check of every source on the worker."
              : pending.to === "ACTIVE"
                ? "Searches will start querying this source."
                : "Searches stop querying this source. Stored offers are kept."
          }
          confirmLabel={
            pending.kind === "health"
              ? "Queue check"
              : pending.to === "ACTIVE"
                ? "Enable"
                : "Disable"
          }
          destructive={pending.kind === "status" && pending.to === "DISABLED"}
          pending={m.isPending}
          error={m.error ? errorMessage(m.error) : null}
          onConfirm={(reason) => m.mutate({ p: pending, reason })}
        />
      ) : null}
      {editing ? <SettingsDialog source={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
