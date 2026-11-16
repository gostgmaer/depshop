"use client";

/**
 * One-click unsubscribe from an email footer. Unsubscribing needs a click
 * (not page load), so link scanners that prefetch emails can't do it.
 */
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth-hooks";
import { notifications } from "@/services";

const LABEL = { PRICE_ALERTS: "price alert", SEARCH: "search update", ACCOUNT: "account" } as const;

export function Unsubscribe() {
  const token = useSearchParams().get("token");
  const run = useMutation({ mutationFn: (t: string) => notifications.unsubscribe(t) });
  if (!token) return <Alert tone="error">This unsubscribe link is incomplete.</Alert>;
  if (run.isSuccess)
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">
          You won&apos;t get {LABEL[run.data.category]} emails any more. In-app notifications are
          unchanged.
        </Alert>
        <Button variant="outline" asChild>
          <Link href="/settings/notifications">Notification settings</Link>
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      {run.isError ? <Alert tone="error">{errorMessage(run.error)}</Alert> : null}
      <p className="text-sm text-muted-foreground">
        Stop receiving this kind of email from DealMind. You can turn it back on any time in your
        notification settings.
      </p>
      <Button onClick={() => run.mutate(token)} disabled={run.isPending}>
        {run.isPending ? "Unsubscribing…" : "Unsubscribe from these emails"}
      </Button>
    </div>
  );
}
