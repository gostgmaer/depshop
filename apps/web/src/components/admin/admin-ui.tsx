"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/misc";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/primitives";
import { LoadingRows } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth-hooks";
import { cn } from "@/lib/utils";

const nf = new Intl.NumberFormat("en-IN");
export const num = (n: number | null | undefined) => (n == null ? "—" : nf.format(n));

/** A single headline number (no chart needed). */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "warning" | "danger";
}) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tracking-tight tabular",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">{children}</div>;
}

/** Health/status with an icon and a word (never colour alone). */
export function HealthBadge({ value }: { value: string }) {
  const v = value.toLowerCase();
  if (["ok", "healthy", "active", "ready"].includes(v))
    return (
      <Badge tone="success">
        <CheckCircle2 aria-hidden className="size-3" /> {labelOf(value)}
      </Badge>
    );
  if (["degraded", "warning", "past_due", "pending_credentials", "pending_approval"].includes(v))
    return (
      <Badge tone="warning">
        <AlertTriangle aria-hidden className="size-3" /> {labelOf(value)}
      </Badge>
    );
  if (["fail", "down", "unhealthy", "failed", "suspended", "error"].includes(v))
    return (
      <Badge tone="danger">
        <XCircle aria-hidden className="size-3" /> {labelOf(value)}
      </Badge>
    );
  return (
    <Badge tone="neutral">
      <CircleDashed aria-hidden className="size-3" /> {labelOf(value)}
    </Badge>
  );
}

export function labelOf(v: string): string {
  if (v === "not_configured") return "Not configured";
  const s = v.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Loading / error wrapper for one query. */
export function QueryState<T>({
  query,
  label,
  children,
}: {
  query: { data: T | undefined; isPending: boolean; error: unknown; refetch: () => unknown };
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingRows rows={3} label={`Loading ${label}`} />;
  if (query.error || query.data === undefined)
    return (
      <ErrorState
        message={query.error ? errorMessage(query.error) : `Couldn't load ${label}.`}
        onRetry={() => void query.refetch()}
      />
    );
  return <>{children(query.data)}</>;
}

/**
 * Confirmation for an audited admin action. A written reason is required
 * (stored in the audit log with the admin, target and request id).
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const valid = reason.trim().length >= 3;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        role={destructive ? "alertdialog" : "dialog"}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onConfirm(reason.trim());
          }}
        >
          <Field label="Reason (recorded in the audit log)" hint="At least 3 characters.">
            {(p) => (
              <textarea
                {...p}
                required
                minLength={3}
                maxLength={500}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
            )}
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
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
              variant={destructive ? "danger" : "default"}
              disabled={!valid || pending}
            >
              {pending ? "Working…" : confirmLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ranked magnitudes as thin horizontal bars (one hue; the value is printed,
 * so the bar is never the only carrier of the number). Works as its own table.
 */
export function BarList({
  rows,
  label,
  valueLabel,
}: {
  rows: { key: string; label: ReactNode; value: number; detail?: ReactNode }[];
  label: string;
  valueLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{label}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Name</th>
          <th scope="col">{valueLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="align-top">
            <th scope="row" className="w-full py-1.5 pr-3 text-left font-normal">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate">{r.label}</span>
                <span aria-hidden className="h-1.5 rounded-full bg-muted">
                  <span
                    className="block h-1.5 rounded-full bg-(--color-series-1)"
                    style={{ width: `${(r.value / max) * 100}%` }}
                  />
                </span>
                {r.detail ? (
                  <span className="text-xs text-muted-foreground">{r.detail}</span>
                ) : null}
              </div>
            </th>
            <td className="py-1.5 text-right whitespace-nowrap tabular">{num(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Responsive table wrapper (horizontal scroll inside the card, never the page).
 * `relative` is required: it makes this the containing block for `sr-only` labels
 * (position: absolute), which would otherwise escape the scroll clip and widen the page.
 */
export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      className="relative -mx-5 overflow-x-auto px-5 sm:-mx-6 sm:px-6"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

export const th = "px-2 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
export const td = "px-2 py-2.5 align-top";
